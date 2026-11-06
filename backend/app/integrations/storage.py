"""Object storage adapter. Public covers and private originals are kept apart (spec 17.6)."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Protocol

from app.config import get_settings


class Storage(Protocol):
    async def put(self, key: str, data: bytes, mime: str, public: bool) -> None: ...
    async def get(self, key: str, public: bool) -> bytes: ...
    async def make_public(self, key: str, data_mime: str) -> None: ...
    def public_url(self, key: str) -> str: ...


class LocalStorage:
    def __init__(self, root: str, public_base: str):
        self.root = Path(root).resolve()
        self.public_base = public_base.rstrip("/")
        (self.root / "public").mkdir(parents=True, exist_ok=True)
        (self.root / "private").mkdir(parents=True, exist_ok=True)

    def _path(self, key: str, public: bool) -> Path:
        p = (self.root / ("public" if public else "private") / key).resolve()
        if not str(p).startswith(str(self.root)):
            raise ValueError("bad key")
        return p

    async def put(self, key: str, data: bytes, mime: str, public: bool) -> None:
        p = self._path(key, public)
        p.parent.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(p.write_bytes, data)

    async def get(self, key: str, public: bool) -> bytes:
        return await asyncio.to_thread(self._path(key, public).read_bytes)

    async def make_public(self, key: str, data_mime: str) -> None:
        src = self._path(key, False)
        dst = self._path(key, True)
        if src.exists() and not dst.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            await asyncio.to_thread(dst.write_bytes, src.read_bytes())

    def public_url(self, key: str) -> str:
        return f"{self.public_base}/media/{key}"


class S3Storage:
    """S3-compatible storage (AWS S3, MinIO, Cloudflare R2...). Requires ``boto3``."""

    def __init__(self):
        import boto3  # type: ignore

        s = get_settings()
        self.client = boto3.client(
            "s3",
            endpoint_url=s.s3_endpoint_url or None,
            aws_access_key_id=s.s3_access_key or None,
            aws_secret_access_key=s.s3_secret_key or None,
            region_name=s.s3_region,
        )
        self.private_bucket = s.s3_bucket_private
        self.public_bucket = s.s3_bucket_public
        self.public_base = s.s3_public_base_url.rstrip("/")

    async def put(self, key: str, data: bytes, mime: str, public: bool) -> None:
        bucket = self.public_bucket if public else self.private_bucket
        await asyncio.to_thread(self.client.put_object, Bucket=bucket, Key=key, Body=data, ContentType=mime)

    async def get(self, key: str, public: bool) -> bytes:
        bucket = self.public_bucket if public else self.private_bucket
        obj = await asyncio.to_thread(self.client.get_object, Bucket=bucket, Key=key)
        return await asyncio.to_thread(obj["Body"].read)

    async def make_public(self, key: str, data_mime: str) -> None:
        await asyncio.to_thread(
            self.client.copy_object,
            Bucket=self.public_bucket,
            Key=key,
            CopySource={"Bucket": self.private_bucket, "Key": key},
            ContentType=data_mime,
            MetadataDirective="REPLACE",
        )

    def public_url(self, key: str) -> str:
        return f"{self.public_base}/{key}"


_storage: Storage | None = None


def get_storage() -> Storage:
    global _storage
    if _storage is None:
        s = get_settings()
        if s.storage_backend == "s3":
            _storage = S3Storage()
        else:
            _storage = LocalStorage(os.path.abspath(s.storage_local_dir), s.public_base_url)
    return _storage


def reset_storage() -> None:
    global _storage
    _storage = None
