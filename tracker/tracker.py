"""PlayBox native pose tracker.

Reads the camera, runs a single-pass multi-person pose model (RTMO, via OpenVINO on the
GPU when there is one), tracks the players (players.py: stable ids, One Euro smoothing, body
measures, gestures, jump state, hand cursors) and streams them to the browser over WebSocket.
The browser only seats them (slots, colours) and lays them out.

Protocol (see packages/sdk/src/sources/websocket.ts and protocol.ts). The page says on connect
{"v": 2, "rotate": 0 | 180}: it speaks protocol v2, and which way up the camera is mounted (the
picture is turned before tracking). Then one JSON text message per camera frame:

v2 (pages that sent {"v": 2}):
    {"v": 2, "t": 81234.5, "aspect": 1.3333, "detections": 2, "stats": {...}?,
     "players": [{
        "id": 1, "since": 80100.2, "det": 0,             # joined at (tracker ms); detection index (-1: unseen)
        "kp": [[x, y, score, vx, vy] x 17],              # smoothed, MIRRORED, COCO-17; velocities per second
        "center": [x, y], "bbox": [x, y, w, h], "confidence": 0.81,
        "body": {"shoulder", "torso", "arm", "height"},  # see protocol.ts for units
        "motion": {"vx", "vy", "dx", "speed", "drift": [x, y]},
        "facing": "front" | "side" | "back", "distance": "far" | "ok" | "close",
        "pose": {"handsUp", "crouching", "crouchDepth", "lean", "leanAngle", "armsOut", "run",
                 "handsTogether", "balance": null | "left" | "right"},
        "jump": {"airborne", "height", "rise", "airTime", "peak"},
        "cursor": {"x", "y", "hand"} | null}, ...],
     "events": [{"type": "join" | "leave" | "jump" | "land" | "handsUp" | "crouch" | "lean" |
                 "armsOut" | "clap" | "punch" | "kick", "id": 1, ...extra}]}
    Extras: lean "direction"; punch "hand", "speed"; kick "foot"; land "airTime", "height".
v1 (older pages, which don't say "v"): {"aspect": 1.333, "poses": [[[x, y, score] x 17], ...],
    "stats"?} - raw poses, x/y 0..1 in UN-mirrored camera space; the page tracks players itself.
"t" is the tracker's clock (ms) when the camera frame was taken. "stats" comes about once a second.

Mirroring: v2 keypoints, centres, boxes and cursors are mirrored here (x -> 1 - x), so the screen
behaves like a mirror. Raw v1 poses, previews and cut-outs are NOT mirrored (camera space).

A page may also send {"preview": true} to get small JPEG camera frames, for the debug page,
{"segment": true} to get a cut-out picture of each person (for the camera overlay), and
{"smooth": false} (?smooth=0) for unsmoothed keypoints while it's connected. On connect the
tracker sends {"config": {"baseline": 0.95}}: the default line players' feet are drawn on
(--baseline).

Binary messages start with a type byte:
    0x01 + JPEG                         a camera preview frame (upright, un-mirrored)
    0x02 + u32le n + JSON(n) + images   person cut-outs from one camera frame. JSON:
        {"seq", "aspect", "people": [{"box": [x0, y0, x1, y1], "pose": i, "player": id,
         "anchor": [x, y] | null, "bytes": n}]}; each person's image is a WebP with alpha (their
        pixels, background transparent) covering "box" (0..1, un-mirrored upright camera space).
        "player" is the id of the player it is (-1 if none), "pose" the index of the matching
        detection in that frame (-1 if none) and "anchor" that pose's torso centre (un-mirrored),
        so the browser can keep the picture on the player as they move.
Camera images never leave this machine: the server only listens on localhost unless told otherwise.

Run with `npm run tracker` (sets up tracker/.venv first), or `python tracker.py --help`.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import signal
import sys
import threading
import time
import urllib.request
import zipfile
from pathlib import Path

import cv2
import numpy as np
import openvino as ov
import websockets
from websockets.asyncio.server import ServerConnection, serve

from players import PlayerTracker

HERE = Path(__file__).resolve().parent
MODELS = HERE / "models"
MODEL_URLS = {
    "rtmo-s": "https://download.openmmlab.com/mmpose/v1/projects/rtmo/onnx_sdk/rtmo-s_8xb32-600e_body7-640x640-dac2bf74_20231211.zip",
    "rtmo-m": "https://download.openmmlab.com/mmpose/v1/projects/rtmo/onnx_sdk/rtmo-m_16xb16-600e_body7-640x640-39e78cc4_20231211.zip",
    "rtmo-l": "https://download.openmmlab.com/mmpose/v1/projects/rtmo/onnx_sdk/rtmo-l_16xb16-600e_body7-640x640-b37118ce_20231211.zip",
}
INPUT = 640  # RTMO's input is fixed at 640x640 (its positional encodings are baked in)
PAD = 114
PREVIEW_FPS = 30
PREVIEW_WIDTH = 320
MSG_PREVIEW = b"\x01"
MSG_CUTOUTS = b"\x02"

# Person instance segmentation for the camera overlay: Intel's Open Model Zoo
# instance-segmentation-person-0007 (Apache-2.0; PointRend + EfficientNet-B1, people only, up
# to 10). Its own input is 320x544; reshaped to 320x448, which a 4:3 frame fills with less padding.
SEG_MODEL = "instance-segmentation-person-0007"
SEG_URL = f"https://storage.openvinotoolkit.org/repositories/open_model_zoo/2023.0/models_bin/1/{SEG_MODEL}/FP16/{SEG_MODEL}"
SEG_INPUT = (320, 448)  # h, w
SEG_SCORE = 0.5  # keep a person this sure...
SEG_SCORE_POSED = 0.15  # ...or this sure if a tracked pose falls inside them (small, far-off children score low)
CUTOUT_HEIGHT = 240  # max px height of each person's picture (most are smaller)

# Pages allowed to connect: the dev server / local builds, and the published site.
DEFAULT_ORIGINS = [
    re.compile(r"https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?"),
    "https://mikedreambooth.github.io",
]


def log(*a: object) -> None:
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ---------- camera ----------


class OpenCVCamera:
    """Any webcam OpenCV can open (V4L2 on Linux, Media Foundation on Windows)."""

    def __init__(self, index: int, width: int, height: int, fps: int):
        backend = cv2.CAP_V4L2 if sys.platform.startswith("linux") else cv2.CAP_ANY
        self.cap = cv2.VideoCapture(index, backend)
        if not self.cap.isOpened():
            raise RuntimeError(f"Could not open camera {index}")
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        self.cap.set(cv2.CAP_PROP_FPS, fps)
        self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        self.width = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        self.height = int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        self.fps = round(self.cap.get(cv2.CAP_PROP_FPS)) or fps
        self.frames = 0
        self._latest: np.ndarray | None = None
        self._seq = 0
        self._new = threading.Condition()
        self._running = True
        self._thread = threading.Thread(target=self._run, name="camera", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while self._running:
            ok, img = self.cap.read()
            if not ok:
                time.sleep(0.01)
                continue
            with self._new:
                self._latest = img
                self._seq += 1
                self.frames += 1
                self._new.notify_all()

    def read(self, after: int = 0, timeout: float = 1.0) -> tuple[int, np.ndarray | None]:
        with self._new:
            self._new.wait_for(lambda: self._seq > after or not self._running, timeout)
            return self._seq, self._latest

    def close(self) -> None:
        self._running = False
        self._thread.join(2)  # release() while read() is still running can hang the driver
        self.cap.release()


class FileCamera:
    """A picture or video file standing in for the camera (for testing without one): played
    at --fps, looped. Same interface as OpenCVCamera."""

    def __init__(self, path: str, fps: int):
        img = cv2.imread(path, cv2.IMREAD_COLOR) if Path(path).suffix.lower() in (".jpg", ".jpeg", ".png", ".webp", ".bmp") else None
        self.still = img
        self.cap = None if img is not None else cv2.VideoCapture(path)
        if img is None and not (self.cap and self.cap.isOpened()):
            raise RuntimeError(f"Could not open {path}")
        if img is None:
            self.width = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            self.height = int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        else:
            self.height, self.width = img.shape[:2]
        self.fps = fps
        self.frames = 0
        self._latest: np.ndarray | None = None
        self._seq = 0
        self._new = threading.Condition()
        self._running = True
        self._thread = threading.Thread(target=self._run, name="camera", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        t = time.perf_counter()
        while self._running:
            if self.still is not None:
                img = self.still.copy()
            else:
                ok, img = self.cap.read()
                if not ok:
                    self.cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                    continue
            with self._new:
                self._latest = img
                self._seq += 1
                self.frames += 1
                self._new.notify_all()
            t += 1 / self.fps
            time.sleep(max(0.0, t - time.perf_counter()))

    read = OpenCVCamera.read

    def close(self) -> None:
        self._running = False
        self._thread.join(2)
        if self.cap:
            self.cap.release()


def open_camera(args: argparse.Namespace):
    want = args.camera
    if not want.isdigit() and want not in ("auto", "ps3eye"):
        cam = FileCamera(want, args.fps)
        log(f"Camera: file {want}, {cam.width}x{cam.height}@{cam.fps} (looped)")
        return cam
    if want in ("auto", "ps3eye") and not sys.platform.startswith("linux"):
        try:
            import ps3eye

            if want == "ps3eye" or ps3eye.present():
                cam = ps3eye.PS3Eye(args.fps)
                log(f"Camera: PlayStation Eye over USB, {cam.width}x{cam.height}@{cam.fps}")
                return cam
        except Exception as e:  # noqa: BLE001 - fall back to a normal webcam
            if want == "ps3eye":
                raise
            log(f"PS3 Eye over USB unavailable ({e}); using a normal webcam")
    index = 0 if want in ("auto", "ps3eye") else int(want)
    cam = OpenCVCamera(index, args.width, args.height, args.fps)
    log(f"Camera: #{index}, {cam.width}x{cam.height}@{cam.fps}")
    return cam


# ---------- model ----------


def model_path(name: str) -> Path:
    path = MODELS / f"{name}.onnx"
    if path.exists():
        return path
    MODELS.mkdir(exist_ok=True)
    zpath = MODELS / f"{name}.zip"
    log(f"Downloading {name} pose model (one time)...")
    urllib.request.urlretrieve(MODEL_URLS[name], zpath)
    with zipfile.ZipFile(zpath) as z:
        onnx = next(n for n in z.namelist() if n.endswith(".onnx"))
        path.write_bytes(z.read(onnx))
    zpath.unlink()
    return path


class PoseModel:
    """RTMO: one pass finds every person (cost doesn't grow with players)."""

    def __init__(self, name: str, device: str, jobs: int):
        core = ov.Core()
        core.set_property({"CACHE_DIR": str(MODELS / "cache")})
        if device == "auto":
            device = "GPU" if "GPU" in core.available_devices else "CPU"
        model = core.read_model(model_path(name))
        model.reshape({0: [1, 3, INPUT, INPUT]})
        # One frame at a time. Two in flight only pays off on an idle GPU (~35 -> ~56 fps on Intel
        # Arc); with the browser drawing on the same GPU it gave the same fps at +50% latency.
        jobs = jobs or 1
        # Feed uint8 BGR images as-is; the device does the float conversion and layout change.
        ppp = ov.preprocess.PrePostProcessor(model)
        ppp.input().tensor().set_element_type(ov.Type.u8).set_layout(ov.Layout("NHWC"))
        ppp.input().model().set_layout(ov.Layout("NCHW"))
        model = ppp.build()
        log(f"Compiling {name} for {device} (the first time on a GPU takes ~30 s)...")
        hint = "THROUGHPUT" if jobs > 1 else "LATENCY"
        self.compiled = core.compile_model(model, device, {"PERFORMANCE_HINT": hint})
        self.device = device
        self.name = name
        self.jobs = jobs
        self.input = np.full((1, INPUT, INPUT, 3), PAD, np.uint8)

    def prepare(self, img: np.ndarray) -> tuple[np.ndarray, float]:
        """Letterbox into the top-left of the 640x640 input; returns (tensor, scale)."""
        h, w = img.shape[:2]
        ratio = min(INPUT / h, INPUT / w)
        if ratio != 1:
            img = cv2.resize(img, (int(w * ratio), int(h * ratio)), interpolation=cv2.INTER_LINEAR)
        self.input[...] = PAD
        self.input[0, : img.shape[0], : img.shape[1]] = img
        return self.input, ratio


def seg_model_path() -> Path:
    path = MODELS / f"{SEG_MODEL}.xml"
    if path.exists() and path.with_suffix(".bin").exists():
        return path
    MODELS.mkdir(exist_ok=True)
    log("Downloading person segmentation model (one time, 18 MB)...")
    for ext in (".bin", ".xml"):  # .xml last: it marks the download complete
        tmp = MODELS / f"{SEG_MODEL}{ext}.part"
        urllib.request.urlretrieve(SEG_URL + ext, tmp)
        tmp.replace(MODELS / f"{SEG_MODEL}{ext}")
    return path


def torso_centre(pose: list) -> list[float] | None:
    """Midpoint of the shoulders and hips that were seen (like the SDK's Player.center)."""
    pts = [pose[i] for i in (5, 6, 11, 12) if pose[i][2] >= 0.3]
    if not pts:
        return None
    return [round(sum(p[0] for p in pts) / len(pts), 4), round(sum(p[1] for p in pts) / len(pts), 4)]


class Segmenter:
    """Cuts each person out of the camera picture, on its own thread (on the CPU by default, so
    it doesn't queue behind pose tracking on the GPU). Takes a frame only when idle."""

    def __init__(self, device: str, threads: int, fps: float):
        self.device = device
        self.threads = threads
        self.fps = fps
        self.compiled = None
        self.failed = False
        self.busy = False
        self.last = 0.0  # perf_counter of the last frame taken
        self.ms = 0.0  # running mean of the whole step (model + cut-outs)
        self.done = 0
        self._job: tuple | None = None
        self._cond = threading.Condition()
        self._thread = threading.Thread(target=self._run, name="segment", daemon=True)
        self._thread.start()

    def load(self) -> None:
        core = ov.Core()
        core.set_property({"CACHE_DIR": str(MODELS / "cache")})
        model = core.read_model(seg_model_path())
        model.reshape({0: [1, 3, *SEG_INPUT]})
        ppp = ov.preprocess.PrePostProcessor(model)
        ppp.input().tensor().set_element_type(ov.Type.u8).set_layout(ov.Layout("NHWC"))
        ppp.input().model().set_layout(ov.Layout("NCHW"))
        model = ppp.build()
        config: dict = {"PERFORMANCE_HINT": "LATENCY"}
        if self.device == "CPU" and self.threads:
            config["INFERENCE_NUM_THREADS"] = self.threads
        self.compiled = core.compile_model(model, self.device, config)
        self.request = self.compiled.create_infer_request()
        self.input = np.zeros((1, *SEG_INPUT, 3), np.uint8)
        log(f"Person segmentation ready ({SEG_MODEL} on {self.device})")

    def want(self, now: float) -> bool:
        return not self.busy and not self.failed and now - self.last >= 1 / self.fps

    def submit(self, job: tuple) -> None:
        with self._cond:
            self.busy = True
            self.last = time.perf_counter()
            self._job = job
            self._cond.notify()

    def _run(self) -> None:
        while True:
            with self._cond:
                self._cond.wait_for(lambda: self._job is not None)
                job, self._job = self._job, None
            img, poses_for, send = job
            try:
                if self.compiled is None:
                    self.load()
                t = time.perf_counter()
                people = self.cut(img, poses_for)
                self.ms += ((time.perf_counter() - t) * 1000 - self.ms) * 0.1
                self.done += 1
                send(people)
            except Exception as e:  # noqa: BLE001 - keep tracking poses without it
                self.failed = True
                log(f"Person segmentation unavailable: {e}")
            finally:
                self.busy = False

    def cut(self, img: np.ndarray, poses_for) -> tuple[list[dict], list[bytes]]:
        """-> (per-person info, per-person WebP), as in the module docstring."""
        h, w = img.shape[:2]
        ih, iw = SEG_INPUT
        ratio = min(ih / h, iw / w)
        small = cv2.resize(img, (int(w * ratio), int(h * ratio)), interpolation=cv2.INTER_AREA)
        self.input[...] = 0
        self.input[0, : small.shape[0], : small.shape[1]] = small
        res = self.request.infer({0: self.input})
        boxes = res[self.compiled.output("boxes")]
        masks = res[self.compiled.output("masks")]
        poses, ids = poses_for()  # this same frame's poses (ready by now) and their player ids
        people: list[dict] = []
        images: list[bytes] = []
        for box, heat in zip(boxes, masks):
            if box[4] < SEG_SCORE_POSED:
                continue
            x0, y0, x1, y1 = box[:4] / ratio
            # Grow the box a little: the model's boxes clip hands and hair.
            gx, gy = (x1 - x0) * 0.04, (y1 - y0) * 0.02
            bx0, by0 = max(0, int(x0 - gx)), max(0, int(y0 - gy))
            bx1, by1 = min(w, int(np.ceil(x1 + gx))), min(h, int(np.ceil(y1 + gy)))
            if bx1 - bx0 < 8 or by1 - by0 < 8:
                continue
            # The heatmap covers the model's box; place it inside the grown box.
            scale = min(1.0, CUTOUT_HEIGHT / (by1 - by0))
            ow, oh = max(1, round((bx1 - bx0) * scale)), max(1, round((by1 - by0) * scale))
            m = np.zeros((oh, ow), np.float32)
            mx0, my0 = round((x0 - bx0) * scale), round((y0 - by0) * scale)
            mw, mh = max(1, round((x1 - x0) * scale)), max(1, round((y1 - y0) * scale))
            hm = cv2.resize(heat, (mw, mh), interpolation=cv2.INTER_LINEAR)
            sx0, sy0 = max(0, -mx0), max(0, -my0)
            dx0, dy0 = max(0, mx0), max(0, my0)
            cw, ch = min(ow - dx0, mw - sx0), min(oh - dy0, mh - sy0)
            if cw > 0 and ch > 0:
                m[dy0 : dy0 + ch, dx0 : dx0 + cw] = hm[sy0 : sy0 + ch, sx0 : sx0 + cw]
            # Soft edge: 0.3 -> transparent, 0.7 -> opaque.
            alpha = np.clip((m - 0.3) * (255 / 0.4), 0, 255).astype(np.uint8)
            crop = cv2.resize(img[by0:by1, bx0:bx1], (ow, oh), interpolation=cv2.INTER_AREA)
            rgba = np.dstack([crop, alpha])
            rgba[alpha == 0, :3] = 0  # compresses better
            people.append({
                "box": [round(bx0 / w, 4), round(by0 / h, 4), round(bx1 / w, 4), round(by1 / h, 4)],
                "mask": (alpha, bx0, by0, bx1, by1),
                "score": float(box[4]),
                "rgba": rgba,
            })
        match_poses(people, poses, ids, w, h)
        out: list[dict] = []
        for p in people:
            if p["score"] < SEG_SCORE and p["pose"] < 0:
                continue  # unsure, and nobody's pose is in it
            ok, webp = cv2.imencode(".webp", p.pop("rgba"), [cv2.IMWRITE_WEBP_QUALITY, 75])
            if not ok:
                continue
            del p["mask"], p["score"]
            p["bytes"] = len(webp)
            out.append(p)
            images.append(webp.tobytes())
        return out, images


def match_poses(people: list[dict], poses: list, ids: list[int], w: int, h: int) -> None:
    """Give each cut-out the pose whose keypoints fall inside its mask most (one each), and so
    that pose's player id (ids: player id per pose, -1 for none)."""
    pairs = []
    for i, p in enumerate(people):
        alpha, x0, y0, x1, y1 = p["mask"]
        mh, mw = alpha.shape
        for j, pose in enumerate(poses):
            hits = 0
            for x, y, s in pose:
                if s < 0.3:
                    continue
                u, v = int((x * w - x0) / (x1 - x0) * mw), int((y * h - y0) / (y1 - y0) * mh)
                if 0 <= u < mw and 0 <= v < mh and alpha[v, u] > 128:
                    hits += 1
            if hits >= 3:
                pairs.append((hits, i, j))
    used_p, used_q = set(), set()
    for p in people:
        p["pose"], p["player"], p["anchor"] = -1, -1, None
    for _, i, j in sorted(pairs, reverse=True):
        if i in used_p or j in used_q:
            continue
        used_p.add(i)
        used_q.add(j)
        people[i]["pose"] = j
        people[i]["player"] = ids[j] if j < len(ids) else -1
        people[i]["anchor"] = torso_centre(poses[j])


def nms(boxes: np.ndarray, scores: np.ndarray, iou: float) -> list[int]:
    order = scores.argsort()[::-1]
    keep: list[int] = []
    areas = (boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1])
    while order.size:
        i = order[0]
        keep.append(int(i))
        xx1 = np.maximum(boxes[i, 0], boxes[order[1:], 0])
        yy1 = np.maximum(boxes[i, 1], boxes[order[1:], 1])
        xx2 = np.minimum(boxes[i, 2], boxes[order[1:], 2])
        yy2 = np.minimum(boxes[i, 3], boxes[order[1:], 3])
        inter = np.maximum(0, xx2 - xx1) * np.maximum(0, yy2 - yy1)
        overlap = inter / (areas[i] + areas[order[1:]] - inter + 1e-6)
        order = order[1:][overlap <= iou]
    return keep


def to_poses(dets: np.ndarray, kps: np.ndarray, ratio: float, w: int, h: int, args) -> list:
    dets, kps = dets[0], kps[0]
    ok = dets[:, 4] >= args.score
    dets, kps = dets[ok], kps[ok]
    if not len(dets):
        return []
    keep = nms(dets[:, :4], dets[:, 4], 0.45)[: args.max_people]
    kps = kps[keep].astype(np.float64)  # float32 would print as 0.7207000255584717
    kps[..., 0] /= ratio * w
    kps[..., 1] /= ratio * h
    kps[..., :2] = kps[..., :2].clip(0, 1)
    return np.round(kps, 4).tolist()


# ---------- server ----------


class Hub:
    """Connected browsers, and what each wants."""

    def __init__(self, rotate: int, baseline: float, tracker: PlayerTracker, smooth: bool) -> None:
        self.clients: set[ServerConnection] = set()
        self.v2: set[ServerConnection] = set()  # speak protocol v2 (tracked players); the rest get raw poses
        self.unsmoothed: set[ServerConnection] = set()  # asked for {"smooth": false}
        self.tracker = tracker
        self.smooth = smooth  # False with --no-smooth: off for everyone
        self.preview: set[ServerConnection] = set()
        self.segment: set[ServerConnection] = set()  # want person cut-outs
        self.latest: np.ndarray | None = None  # newest camera image (turned upright), for previews
        self.rotate = rotate  # 0 or 180: the camera is mounted upside down
        self.baseline = baseline  # default feet line for the page's player layout (fraction of screen height)

    async def handler(self, ws: ServerConnection) -> None:
        self.clients.add(ws)
        # Settings for the page, announced once on connect.
        await ws.send(json.dumps({"config": {"baseline": self.baseline}}))
        log(f"Browser connected ({ws.request.headers.get('Origin', 'no origin')}); {len(self.clients)} now")
        try:
            async for msg in ws:
                if isinstance(msg, str):
                    try:
                        m = json.loads(msg)
                        want = m.get("preview")
                        segment = m.get("segment")
                        rotate = m.get("rotate")
                        version = m.get("v")
                        smooth = m.get("smooth")
                    except (ValueError, AttributeError):
                        continue
                    if version == 2:
                        self.v2.add(ws)
                    if smooth is False:
                        self.unsmoothed.add(ws)
                    elif smooth is True:
                        self.unsmoothed.discard(ws)
                    self.sync_smoothing()
                    if want:
                        self.preview.add(ws)
                    elif want is not None:
                        self.preview.discard(ws)
                    if segment:
                        self.segment.add(ws)
                    elif segment is not None:
                        self.segment.discard(ws)
                    if rotate in (0, 180) and rotate != self.rotate:
                        self.rotate = rotate
                        log(f"Camera rotation: {rotate}")
        finally:
            self.clients.discard(ws)
            self.preview.discard(ws)
            self.segment.discard(ws)
            self.v2.discard(ws)
            self.unsmoothed.discard(ws)
            self.sync_smoothing()
            log(f"Browser disconnected; {len(self.clients)} left")


    def sync_smoothing(self) -> None:
        """Smoothing is off while any page asks for it off (?smooth=0), or with --no-smooth."""
        on = self.smooth and not self.unsmoothed
        if on != self.tracker.smoothing:
            self.tracker.set_smoothing(on)
            log(f"Keypoint smoothing {'on' if on else 'off'}")


def run_pipeline(cam, model: PoseModel, seg: Segmenter | None, hub: Hub, loop: asyncio.AbstractEventLoop, args, stop: threading.Event):
    """Camera -> model (several frames in flight on a GPU) -> every connected browser."""
    aspect = cam.width / cam.height
    state = {"sent_seq": 0, "tracked_seq": 0, "sent": 0, "infer": 0.0, "infer_n": 0, "latency": 0.0, "track": 0.0}
    tracker = hub.tracker
    track_lock = threading.Lock()  # player tracking runs one frame at a time, in order
    queue = ov.AsyncInferQueue(model.compiled, model.jobs)
    lock = threading.Lock()  # callbacks run on OpenVINO's threads
    tracked = threading.Condition(lock)
    recent: dict[int, tuple] = {}  # seq -> (poses, player id per pose), for matching cut-outs to players

    def done(req: ov.InferRequest, data) -> None:
        seq, ratio, w, h, t_cam, t_start = data
        with lock:
            if seq <= state["sent_seq"]:
                return  # a newer frame already went out
            state["sent_seq"] = seq
        poses = to_poses(req.get_output_tensor(0).data, req.get_output_tensor(1).data, ratio, w, h, args)
        t_ms = round(t_cam * 1000, 1)
        with track_lock:
            if seq <= state["tracked_seq"]:
                return  # a newer frame was tracked first (several frames in flight)
            state["tracked_seq"] = seq
            t0 = time.perf_counter()
            frame = tracker.update(poses, t_ms, aspect)
            ids = tracker.ids_by_detection(len(poses))
            t_track = time.perf_counter() - t0
        now = time.perf_counter()
        msg = {"aspect": round(aspect, 4), "poses": poses}
        msg2 = {"v": 2, "t": t_ms, "aspect": round(aspect, 4), "detections": len(poses), **frame}
        with lock:
            recent[seq] = (poses, ids)
            for old in [k for k in recent if k < seq - 30]:
                del recent[old]
            tracked.notify_all()
            state["infer"] += now - t_start
            state["infer_n"] += 1
            state["latency"] += now - t_cam
            state["track"] += t_track
            state["sent"] += 1
            if state.get("stats"):
                msg["stats"] = msg2["stats"] = state.pop("stats")
        v2 = set(hub.v2)
        v1 = set(hub.clients) - v2
        if v2:
            loop.call_soon_threadsafe(websockets.broadcast, v2, json.dumps(msg2, separators=(",", ":")))
        if v1:
            loop.call_soon_threadsafe(websockets.broadcast, v1, json.dumps(msg, separators=(",", ":")))

    queue.set_callback(done)

    def poses_for(seq: int):
        def get() -> list:
            with tracked:
                tracked.wait_for(lambda: seq in recent or stop.is_set(), 0.2)
                return recent.get(seq) or recent.get(max(recent, default=0), ([], []))
        return get

    def send_cutouts(seq: int):
        def send(result: tuple[list[dict], list[bytes]]) -> None:
            people, images = result
            head = json.dumps({"seq": seq, "aspect": round(aspect, 4), "people": people}, separators=(",", ":")).encode()
            data = b"".join([MSG_CUTOUTS, len(head).to_bytes(4, "little"), head, *images])
            if hub.segment:
                loop.call_soon_threadsafe(websockets.broadcast, set(hub.segment), data)
        return send

    seg_done0 = seg_seq = 0
    seq = 0
    t_report = time.perf_counter()
    frames0 = cam.frames
    while not stop.is_set():
        # Wait for the model to be free *before* taking a frame, so it always gets the newest one
        # (taking it first left it ageing ~a frame while the previous inference finished).
        queue.get_idle_request_id()
        seq, img = cam.read(seq)
        if img is None:
            continue
        if hub.rotate == 180:  # camera mounted upside down: turn it upright before tracking
            img = cv2.rotate(img, cv2.ROTATE_180)
        t_cam = time.perf_counter()
        tensor, ratio = model.prepare(img)
        h, w = img.shape[:2]
        queue.start_async({0: tensor}, (seq, ratio, w, h, t_cam, time.perf_counter()))
        hub.latest = img
        if seg and hub.segment and seq - seg_seq >= 2 and seg.want(t_cam):  # at most every other frame
            seg_seq = seq
            seg.submit((img, poses_for(seq), send_cutouts(seq)))

        if t_cam - t_report >= 1:
            dt = t_cam - t_report
            n = max(state["infer_n"], 1)
            stats = {
                "camera": f"{cam.width}x{cam.height}",
                "cameraFps": round((cam.frames - frames0) / dt, 1),
                "fps": round(state["sent"] / dt, 1),
                "inferMs": round(state["infer"] / n * 1000, 1),
                "latencyMs": round(state["latency"] / n * 1000, 1),
                "trackMs": round(state["track"] / n * 1000, 2),  # player tracking + gestures, per frame
                "model": f"{model.name} ({model.device} x{model.jobs})",
                "rotation": f"{hub.rotate}°",
            }
            if seg and hub.segment:
                stats["segFps"] = round((seg.done - seg_done0) / dt, 1)
                stats["segMs"] = round(seg.ms, 1)
            if seg:
                seg_done0 = seg.done
            with lock:
                state.update(stats=stats, sent=0, infer=0.0, infer_n=0, latency=0.0, track=0.0)
            frames0, t_report = cam.frames, t_cam
            if args.verbose:
                log(stats)
    queue.wait_all()


async def send_previews(hub: Hub) -> None:
    while True:
        await asyncio.sleep(1 / PREVIEW_FPS)
        img = hub.latest
        if img is None or not hub.preview:
            continue
        small = cv2.resize(img, (PREVIEW_WIDTH, PREVIEW_WIDTH * img.shape[0] // img.shape[1]), interpolation=cv2.INTER_AREA)
        ok, jpg = await asyncio.to_thread(cv2.imencode, ".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 70])
        if ok:
            websockets.broadcast(set(hub.preview), MSG_PREVIEW + jpg.tobytes())


def handle_stop_requests(args: argparse.Namespace) -> None:
    """Shut down cleanly on SIGTERM / console close, and (under `npm run tracker`) when the
    launcher goes away. Ctrl+C is handled by asyncio.run."""
    loop = asyncio.get_running_loop()
    task = asyncio.current_task()
    assert task

    def stop(*_: object) -> None:
        loop.call_soon_threadsafe(task.cancel)

    for name in ("SIGTERM", "SIGBREAK", "SIGHUP"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), stop)
    if args.exit_with_stdin:
        # The launcher holds our stdin open; EOF means it exited (however it died).
        def watch() -> None:
            try:
                sys.stdin.buffer.read()
            except (OSError, ValueError):
                pass
            stop()

        threading.Thread(target=watch, name="stdin-watch", daemon=True).start()


async def main(args: argparse.Namespace) -> None:
    handle_stop_requests(args)
    model = PoseModel(args.model, args.device, args.jobs)
    seg = None
    if args.segment_fps > 0:
        try:
            seg_model_path()  # download now (it's loaded on first use)
            seg = Segmenter(args.segment_device, args.segment_threads, args.segment_fps)
        except Exception as e:  # noqa: BLE001 - poses still work without it
            log(f"Person segmentation unavailable: {e}")
    if args.prepare:
        if seg:
            seg.load()
        log("Model downloaded and compiled; ready.")
        return
    cam = open_camera(args)
    tracker = PlayerTracker(smoothing=not args.no_smooth, max_players=args.players)
    hub = Hub(args.rotate, args.baseline, tracker, not args.no_smooth)
    stop = threading.Event()
    loop = asyncio.get_running_loop()
    worker = threading.Thread(target=run_pipeline, args=(cam, model, seg, hub, loop, args, stop), name="pipeline", daemon=True)
    worker.start()
    origins = DEFAULT_ORIGINS + args.allow_origin
    try:
        async with serve(hub.handler, args.host, args.port, origins=origins, compression=None, close_timeout=1):
            log(f"Tracker ready on ws://{args.host}:{args.port} - open the site with ?input=ws (camera rotation {hub.rotate})")
            try:
                await send_previews(hub)
            finally:
                log("Stopping...")
                # If anything below hangs (camera driver, browsers not answering), exit anyway.
                deadline = threading.Timer(5, os._exit, (1,))
                deadline.daemon = True
                deadline.start()
                release(cam, worker, stop)  # before closing browser connections
    finally:
        release(cam, worker, stop)


def release(cam, worker: threading.Thread, stop: threading.Event) -> None:
    if stop.is_set():
        return
    stop.set()
    worker.join(2)
    cam.close()


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="PlayBox native pose tracker (WebSocket)")
    p.add_argument("--camera", default="auto", help="auto | ps3eye | <OpenCV camera index> | <picture or video file, for testing> (default auto)")
    p.add_argument("--width", type=int, default=640)
    p.add_argument("--height", type=int, default=480)
    p.add_argument("--fps", type=int, default=60)
    p.add_argument("--baseline", type=float, default=0.95, help="where players' feet are drawn by default, as a fraction of the screen height from the top (default 0.95: a little up from the bottom); games can override it")
    p.add_argument("--rotate", type=int, default=180, choices=(0, 180), help="camera mounted upside down? 180 (default) or 0; the site's setting overrides it on connect")
    p.add_argument("--model", default="rtmo-s", choices=sorted(MODEL_URLS), help="rtmo-s (fast) .. rtmo-l (accurate)")
    p.add_argument("--device", default="auto", help="auto | GPU | CPU | NPU (OpenVINO device)")
    p.add_argument("--jobs", type=int, default=0, help="frames in flight (default 1; try 2 on a dedicated GPU)")
    p.add_argument("--score", type=float, default=0.5, help="minimum person confidence")
    p.add_argument("--max-people", type=int, default=6, help="most people the pose model reports per frame")
    p.add_argument("--players", type=int, default=4, help="most players tracked at once (default 4)")
    p.add_argument("--no-smooth", action="store_true", help="no keypoint smoothing (raw positions; velocities are still estimated); a page can ask for this with ?smooth=0")
    p.add_argument("--host", default="127.0.0.1", help="interface to listen on (default: this machine only)")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--allow-origin", action="append", default=[], help="extra site allowed to connect, e.g. https://example.com")
    p.add_argument("--segment-fps", type=float, default=12, help="person cut-outs per second for the camera overlay, while a page asks for them (0 = off)")
    p.add_argument("--segment-device", default="CPU", help="OpenVINO device for person segmentation (default CPU, leaving the GPU to pose tracking)")
    p.add_argument("--segment-threads", type=int, default=4, help="CPU threads for person segmentation (0 = all)")
    p.add_argument("-v", "--verbose", action="store_true", help="print stats every second")
    p.add_argument("--prepare", action="store_true", help="just download + compile the model, then exit (for setup)")
    p.add_argument("--exit-with-stdin", action="store_true", help=argparse.SUPPRESS)  # set by scripts/tracker.mjs
    return p.parse_args()


if __name__ == "__main__":
    try:
        asyncio.run(main(parse_args()))
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    log("Stopped.")
    # Skip interpreter teardown: OpenVINO / libusb destructors can hang it, leaving the port held.
    os._exit(0)
