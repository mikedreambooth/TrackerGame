"""PlayBox native pose tracker.

Reads the camera, runs a single-pass multi-person pose model (RTMO, via OpenVINO on the
GPU when there is one) and streams poses to the browser over WebSocket. Open the site
with ?input=ws (or pick "Native tracker" on the debug page) to use it. Games don't change.

Wire format, one JSON text message per camera frame (see packages/sdk/src/sources/websocket.ts):
    {"aspect": 1.333, "poses": [[[x, y, score] x 17], ...], "stats": {...}?}
x/y are 0..1 in UN-mirrored camera space, COCO-17 order. "stats" comes about once a second.
A client may send {"preview": true} to also get ~15 small JPEG camera frames a second
(binary messages), for the debug page. Camera images never leave this machine: the server
only listens on localhost unless told otherwise.

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


def open_camera(args: argparse.Namespace):
    want = args.camera
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

    def __init__(self) -> None:
        self.clients: set[ServerConnection] = set()
        self.preview: set[ServerConnection] = set()
        self.latest: np.ndarray | None = None  # newest camera image, for previews

    async def handler(self, ws: ServerConnection) -> None:
        self.clients.add(ws)
        log(f"Browser connected ({ws.request.headers.get('Origin', 'no origin')}); {len(self.clients)} now")
        try:
            async for msg in ws:
                if isinstance(msg, str):
                    try:
                        want = json.loads(msg).get("preview")
                    except (ValueError, AttributeError):
                        continue
                    if want:
                        self.preview.add(ws)
                    elif want is not None:
                        self.preview.discard(ws)
        finally:
            self.clients.discard(ws)
            self.preview.discard(ws)
            log(f"Browser disconnected; {len(self.clients)} left")


def run_pipeline(cam, model: PoseModel, hub: Hub, loop: asyncio.AbstractEventLoop, args, stop: threading.Event):
    """Camera -> model (several frames in flight on a GPU) -> every connected browser."""
    aspect = cam.width / cam.height
    state = {"sent_seq": 0, "sent": 0, "infer": 0.0, "infer_n": 0, "latency": 0.0}
    queue = ov.AsyncInferQueue(model.compiled, model.jobs)
    lock = threading.Lock()  # callbacks run on OpenVINO's threads

    def done(req: ov.InferRequest, data) -> None:
        seq, ratio, w, h, t_cam, t_start = data
        with lock:
            if seq <= state["sent_seq"]:
                return  # a newer frame already went out
            state["sent_seq"] = seq
        poses = to_poses(req.get_output_tensor(0).data, req.get_output_tensor(1).data, ratio, w, h, args)
        now = time.perf_counter()
        msg = {"aspect": round(aspect, 4), "poses": poses}
        with lock:
            state["infer"] += now - t_start
            state["infer_n"] += 1
            state["latency"] += now - t_cam
            state["sent"] += 1
            if state.get("stats"):
                msg["stats"] = state.pop("stats")
        if hub.clients:
            loop.call_soon_threadsafe(websockets.broadcast, set(hub.clients), json.dumps(msg, separators=(",", ":")))

    queue.set_callback(done)
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
        t_cam = time.perf_counter()
        tensor, ratio = model.prepare(img)
        h, w = img.shape[:2]
        queue.start_async({0: tensor}, (seq, ratio, w, h, t_cam, time.perf_counter()))
        hub.latest = img

        if t_cam - t_report >= 1:
            dt = t_cam - t_report
            n = max(state["infer_n"], 1)
            stats = {
                "camera": f"{cam.width}x{cam.height}",
                "cameraFps": round((cam.frames - frames0) / dt, 1),
                "fps": round(state["sent"] / dt, 1),
                "inferMs": round(state["infer"] / n * 1000, 1),
                "latencyMs": round(state["latency"] / n * 1000, 1),
                "model": f"{model.name} ({model.device} x{model.jobs})",
            }
            with lock:
                state.update(stats=stats, sent=0, infer=0.0, infer_n=0, latency=0.0)
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
            websockets.broadcast(set(hub.preview), jpg.tobytes())


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
    if args.prepare:
        log("Model downloaded and compiled; ready.")
        return
    cam = open_camera(args)
    hub = Hub()
    stop = threading.Event()
    loop = asyncio.get_running_loop()
    worker = threading.Thread(target=run_pipeline, args=(cam, model, hub, loop, args, stop), name="pipeline", daemon=True)
    worker.start()
    origins = DEFAULT_ORIGINS + args.allow_origin
    try:
        async with serve(hub.handler, args.host, args.port, origins=origins, compression=None, close_timeout=1):
            log(f"Tracker ready on ws://{args.host}:{args.port} - open the site with ?input=ws")
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
    p.add_argument("--camera", default="auto", help="auto | ps3eye | <OpenCV camera index> (default auto)")
    p.add_argument("--width", type=int, default=640)
    p.add_argument("--height", type=int, default=480)
    p.add_argument("--fps", type=int, default=60)
    p.add_argument("--model", default="rtmo-s", choices=sorted(MODEL_URLS), help="rtmo-s (fast) .. rtmo-l (accurate)")
    p.add_argument("--device", default="auto", help="auto | GPU | CPU | NPU (OpenVINO device)")
    p.add_argument("--jobs", type=int, default=0, help="frames in flight (default 1; try 2 on a dedicated GPU)")
    p.add_argument("--score", type=float, default=0.5, help="minimum person confidence")
    p.add_argument("--max-people", type=int, default=6)
    p.add_argument("--host", default="127.0.0.1", help="interface to listen on (default: this machine only)")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--allow-origin", action="append", default=[], help="extra site allowed to connect, e.g. https://example.com")
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
