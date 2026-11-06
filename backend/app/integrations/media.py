"""Media helpers without external binaries: MP4/M4A duration and an optional ClamAV scan.

* ``mp4_duration`` walks the ISO-BMFF boxes (ftyp/moov/mvhd) and returns seconds;
* ``clamav_scan`` speaks the clamd INSTREAM protocol over TCP. It is used only when
  ``HIKOYA_CLAMAV_HOST`` is set (docker compose profile ``antivirus``).
"""

from __future__ import annotations

import asyncio
import struct

from app.config import get_settings


def _boxes(data: bytes, start: int, end: int):
    i = start
    while i + 8 <= end:
        size, typ = struct.unpack(">I4s", data[i : i + 8])
        hdr = 8
        if size == 1:
            if i + 16 > end:
                return
            size = struct.unpack(">Q", data[i + 8 : i + 16])[0]
            hdr = 16
        elif size == 0:
            size = end - i
        if size < hdr or i + size > end:
            # truncated box: stop, never read outside the buffer
            if typ == b"moov":
                yield typ, i + hdr, end
            return
        yield typ, i + hdr, i + size
        i += size


def mp4_duration(data: bytes) -> float | None:
    """Duration in seconds from the movie header (mvhd), or None when not found."""
    for typ, s, e in _boxes(data, 0, len(data)):
        if typ != b"moov":
            continue
        for t2, s2, e2 in _boxes(data, s, e):
            if t2 != b"mvhd" or e2 - s2 < 20:
                continue
            version = data[s2]
            try:
                if version == 1:
                    timescale, duration = struct.unpack(">IQ", data[s2 + 20 : s2 + 32])
                else:
                    timescale, duration = struct.unpack(">II", data[s2 + 12 : s2 + 20])
            except struct.error:
                return None
            if timescale <= 0:
                return None
            return round(duration / timescale, 3)
    return None


class VirusFound(Exception):
    def __init__(self, signature: str):
        super().__init__(signature)
        self.signature = signature


class ScannerUnavailable(Exception):
    pass


async def clamav_scan(data: bytes) -> str:
    """Return "clean", "skipped" (scanner not configured). Raise VirusFound / ScannerUnavailable."""
    s = get_settings()
    if not s.clamav_host:
        return "skipped"
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection(s.clamav_host, s.clamav_port), timeout=5)
    except (OSError, asyncio.TimeoutError) as e:
        raise ScannerUnavailable(str(e)) from e
    try:
        writer.write(b"zINSTREAM\0")
        chunk = 64 * 1024
        for i in range(0, len(data), chunk):
            part = data[i : i + chunk]
            writer.write(struct.pack(">I", len(part)) + part)
            await writer.drain()
        writer.write(struct.pack(">I", 0))
        await writer.drain()
        reply = (await asyncio.wait_for(reader.read(4096), timeout=60)).rstrip(b"\0").decode(errors="replace").strip()
    except (OSError, asyncio.TimeoutError) as e:
        raise ScannerUnavailable(str(e)) from e
    finally:
        writer.close()
    # "stream: OK" | "stream: Eicar-Signature FOUND" | "INSTREAM size limit exceeded. ERROR"
    if reply.endswith("OK"):
        return "clean"
    if reply.endswith("FOUND"):
        raise VirusFound(reply.split(":", 1)[-1].replace("FOUND", "").strip())
    raise ScannerUnavailable(reply)
