"""PlayStation Eye (PS3 Eye) camera straight over USB, via libusb.

Windows has no working webcam driver for the PS3 Eye, so with the generic WinUSB driver
installed (Zadig, or the "PS3 Eye Universal" installer) we program the OV534 bridge +
OV7720 sensor ourselves and read its raw Bayer stream. Same driver as the browser one in
packages/sdk/src/sources/ps3eye.ts; register tables from PS3EYEDriver / Linux gspca ov534.

On Linux the kernel driver already makes it a normal webcam: use OpenCV there instead.
"""

from __future__ import annotations

import threading
import time

import cv2
import numpy as np
import usb1

VENDOR_ID = 0x1415
PRODUCT_ID = 0x2000
EP_IN = 0x81
PAYLOAD = 2048  # bytes per UVC-style payload, including its 12-byte header
# A few big reads: with libusb + WinUSB, 16 x 128 KB only managed ~1 fps (the camera's buffer
# overflows between reads), 8 x 1 MB keeps up with 60 fps. A read ends early at each frame's end.
TRANSFER = 512 * PAYLOAD
IN_FLIGHT = 8

W, H = 640, 480
FRAME_BYTES = W * H

REG_ADDRESS, REG_SUBADDR, REG_WRITE, REG_READ, REG_OPERATION, REG_STATUS = 0xF1, 0xF2, 0xF3, 0xF4, 0xF5, 0xF6
OP_WRITE_3, OP_WRITE_2, OP_READ_2 = 0x37, 0x33, 0xF9

BRIDGE_INIT = [
    (0xE7, 0x3A), (REG_ADDRESS, 0x42),
    (0x92, 0x01), (0x93, 0x18), (0x94, 0x10), (0x95, 0x10), (0xE2, 0x00), (0xE7, 0x3E),
    (0x96, 0x00), (0x97, 0x20), (0x97, 0x20), (0x97, 0x20), (0x97, 0x0A), (0x97, 0x3F),
    (0x97, 0x4A), (0x97, 0x20), (0x97, 0x15), (0x97, 0x0B),
    (0x8E, 0x40), (0x1F, 0x81), (0xC0, 0x50), (0xC1, 0x3C), (0xC2, 0x01), (0xC3, 0x01),
    (0x50, 0x89), (0x88, 0x08), (0x8D, 0x00), (0x8E, 0x00),
    (0x1C, 0x00), (0x1D, 0x00), (0x1D, 0x02), (0x1D, 0x00), (0x1D, 0x01), (0x1D, 0x2C), (0x1D, 0x00),
    (0x1C, 0x0A), (0x1D, 0x08), (0x1D, 0x0E),
    (0x34, 0x05), (0xE3, 0x04), (0x89, 0x00), (0x76, 0x00), (0xE7, 0x2E), (0x31, 0xF9),
    (0x25, 0x42), (0x21, 0xF0), (0xE5, 0x04),
]
SENSOR_INIT = [
    (0x12, 0x80), (0x3D, 0x00), (0x12, 0x01), (0x11, 0x01), (0x14, 0x40), (0x15, 0x00),
    (0x63, 0xAA), (0x64, 0x87), (0x66, 0x00), (0x67, 0x02), (0x17, 0x26), (0x18, 0xA0),
    (0x19, 0x07), (0x1A, 0xF0), (0x29, 0xA0), (0x2A, 0x00), (0x2C, 0xF0), (0x20, 0x10),
    (0x4E, 0x0F), (0x3E, 0xF3), (0x0D, 0x41), (0x32, 0x00), (0x13, 0xF0), (0x22, 0x7F),
    (0x23, 0x03), (0x24, 0x40), (0x25, 0x30), (0x26, 0xA1), (0x2A, 0x00), (0x2B, 0x00),
    (0x13, 0xF7), (0x0C, 0xC0), (0x11, 0x00), (0x0D, 0x41), (0x8E, 0x00),
]
BRIDGE_START_VGA = [
    (0x1C, 0x00), (0x1D, 0x00), (0x1D, 0x02), (0x1D, 0x00), (0x1D, 0x01), (0x1D, 0x2C),
    (0x1D, 0x00), (0xC0, 0x50), (0xC1, 0x3C),
]
SENSOR_START_VGA = [
    (0x12, 0x01), (0x17, 0x26), (0x18, 0xA0), (0x19, 0x07), (0x1A, 0xF0), (0x29, 0xA0),
    (0x2C, 0xF0), (0x65, 0x20),
]
# 640x480 frame rates: (fps, sensor 0x11, sensor 0x0d, bridge 0xe5)
RATES_VGA = [
    (75, 0x01, 0x81, 0x02), (60, 0x00, 0x41, 0x04), (50, 0x01, 0x41, 0x02),
    (40, 0x02, 0xC1, 0x04), (30, 0x04, 0x81, 0x02), (25, 0x00, 0x01, 0x02),
    (20, 0x04, 0x41, 0x02), (15, 0x09, 0x81, 0x02),
]

_OUT = usb1.TYPE_VENDOR | usb1.RECIPIENT_DEVICE | usb1.ENDPOINT_OUT
_IN = usb1.TYPE_VENDOR | usb1.RECIPIENT_DEVICE | usb1.ENDPOINT_IN


def present() -> bool:
    """True if a PS3 Eye is plugged in (whether or not we can open it)."""
    try:
        with usb1.USBContext() as ctx:
            return ctx.getByVendorIDAndProductID(VENDOR_ID, PRODUCT_ID) is not None
    except usb1.USBError:
        return False


class PS3Eye:
    """Streams 640x480 BGR frames. `read()` returns the newest frame (or None)."""

    def __init__(self, fps: int = 60):
        self.ctx = usb1.USBContext()
        self.ctx.open()
        self.handle = self.ctx.openByVendorIDAndProductID(VENDOR_ID, PRODUCT_ID, skip_on_error=True)
        if self.handle is None:
            raise RuntimeError("PS3 Eye not found, or it can't be opened (WinUSB driver installed? another app using it?)")
        self.handle.claimInterface(0)
        self.width, self.height = W, H
        self.fps = self._start(fps)

        self._frame = bytearray(FRAME_BYTES)
        self._len = 0
        self._collecting = False
        self._last_pts = -1
        self._last_fid = -1
        self._latest: np.ndarray | None = None
        self._seq = 0
        self._lock = threading.Lock()
        self._new = threading.Condition(self._lock)
        self.frames = 0
        self.dropped = 0

        self._running = True  # streaming: transfers get resubmitted
        self._pumping = True  # the event thread is handling libusb events
        self._transfers = []
        for _ in range(IN_FLIGHT):
            t = self.handle.getTransfer()
            t.setBulk(EP_IN, TRANSFER, callback=self._on_transfer)
            t.submit()
            self._transfers.append(t)
        self._thread = threading.Thread(target=self._events, name="ps3eye-usb", daemon=True)
        self._thread.start()

    # ---------- registers ----------

    def _reg(self, reg: int, val: int) -> None:
        self.handle.controlWrite(_OUT, 0x01, 0x00, reg, bytes([val]), 500)

    def _reg_read(self, reg: int) -> int:
        return self.handle.controlRead(_IN, 0x01, 0x00, reg, 1, 500)[0]

    def _sccb_ok(self) -> bool:
        for _ in range(5):
            s = self._reg_read(REG_STATUS)
            if s == 0x00:
                return True
            if s == 0x04:
                return False
        return False

    def _sensor(self, reg: int, val: int) -> None:
        self._reg(REG_SUBADDR, reg)
        self._reg(REG_WRITE, val)
        self._reg(REG_OPERATION, OP_WRITE_3)
        self._sccb_ok()

    def _sensor_read(self, reg: int) -> int:
        self._reg(REG_SUBADDR, reg)
        self._reg(REG_OPERATION, OP_WRITE_2)
        self._sccb_ok()
        self._reg(REG_OPERATION, OP_READ_2)
        self._sccb_ok()
        return self._reg_read(REG_READ)

    def _led(self, on: bool) -> None:
        self._reg(0x21, self._reg_read(0x21) | 0x80)
        d = self._reg_read(0x23)
        self._reg(0x23, d | 0x80 if on else d & ~0x80)
        if not on:
            self._reg(0x21, self._reg_read(0x21) & ~0x80)

    def _start(self, fps: int) -> int:
        self._reg(0xE7, 0x3A)
        self._reg(0xE0, 0x08)  # reset bridge
        time.sleep(0.1)
        self._reg(REG_ADDRESS, 0x42)
        self._sensor(0x12, 0x80)  # reset sensor
        time.sleep(0.01)
        for r, v in BRIDGE_INIT:
            self._reg(r, v)
        for r, v in SENSOR_INIT:
            self._sensor(r, v)
        self._reg(0xE0, 0x09)

        for r, v in BRIDGE_START_VGA:
            self._reg(r, v)
        for r, v in SENSOR_START_VGA:
            self._sensor(r, v)
        rate = next((r for r in RATES_VGA if fps >= r[0]), RATES_VGA[-1])
        self._sensor(0x11, rate[1])
        self._sensor(0x0D, rate[2])
        self._reg(0xE5, rate[3])

        # Auto gain/exposure + auto white balance.
        self._sensor(0x13, 0xF7)
        self._sensor(0x64, self._sensor_read(0x64) | 0x03)
        self._sensor(0x63, 0xE0)
        # Unflipped, like an ordinary webcam (matches the browser driver).
        self._sensor(0x0C, (self._sensor_read(0x0C) & ~0xC0) | 0x40 | 0x80)

        self._led(True)
        self._reg(0xE0, 0x00)  # start stream
        return rate[0]

    # ---------- streaming ----------

    def _events(self) -> None:
        while self._pumping:
            try:
                self.ctx.handleEventsTimeout(0.1)
            except usb1.USBErrorInterrupted:
                pass

    def _on_transfer(self, t: usb1.USBTransfer) -> None:
        if not self._running:
            return
        if t.getStatus() == usb1.TRANSFER_COMPLETED:
            n = t.getActualLength()
            if n:
                self._scan(memoryview(t.getBuffer())[:n])
        try:
            t.submit()
        except usb1.USBError:
            pass

    def _scan(self, data: memoryview) -> None:
        # Each payload has a 12-byte UVC-style header. A new frame starts when the frame
        # id or timestamp changes; it ends at EOF with exactly W*H bytes.
        for off in range(0, len(data), PAYLOAD):
            p = data[off : off + PAYLOAD]
            hdr = p[1] if len(p) > 1 else 0
            if len(p) < 12 or p[0] != 12 or hdr & 0x40 or not hdr & 0x04:
                self._collecting = False
                continue
            pts = int.from_bytes(p[2:6], "little")
            fid = hdr & 0x01
            if pts != self._last_pts or fid != self._last_fid:
                self._last_pts, self._last_fid = pts, fid
                self._len = 0
                self._collecting = True
            if not self._collecting:
                continue
            body = p[12:]
            end = self._len + len(body)
            if end > FRAME_BYTES:
                self._collecting = False
                continue
            self._frame[self._len : end] = body
            self._len = end
            if hdr & 0x02:  # EOF
                self._last_pts = -1
                self._collecting = False
                if self._len != FRAME_BYTES:
                    self.dropped += 1
                    continue
                bayer = np.frombuffer(self._frame, np.uint8).reshape(H, W)
                bgr = cv2.cvtColor(bayer, cv2.COLOR_BayerGB2BGR)
                with self._new:
                    self._latest = bgr
                    self._seq += 1
                    self.frames += 1
                    self._new.notify_all()

    def read(self, after: int = 0, timeout: float = 1.0) -> tuple[int, np.ndarray | None]:
        """Wait for a frame newer than `after`; returns (seq, BGR image)."""
        with self._new:
            self._new.wait_for(lambda: self._seq > after or not self._running, timeout)
            return self._seq, self._latest

    def close(self) -> None:
        if not self._running:
            return
        self._running = False
        try:
            self._reg(0xE0, 0x09)
            self._led(False)
        except usb1.USBError:
            pass
        for t in self._transfers:
            try:
                t.cancel()
            except usb1.USBError:
                pass
        # Keep handling events until the cancellations land: closing the device with transfers
        # still in flight makes libusb wait (or hang) and the camera stays claimed.
        deadline = time.monotonic() + 1
        while any(t.isSubmitted() for t in self._transfers) and time.monotonic() < deadline:
            time.sleep(0.01)
        self._pumping = False
        self._thread.join(1)
        try:
            self.handle.releaseInterface(0)
            self.handle.close()
        except usb1.USBError:
            pass
        self.ctx.close()
