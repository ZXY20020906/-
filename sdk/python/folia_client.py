"""Folia 素材网 Python 客户端（标准库，零依赖，Python ≥ 3.8）。

用法：

    from folia_client import FoliaClient

    client = FoliaClient("https://folia-5ve.pages.dev", api_key="")   # key 可选
    page = client.list(category="wallpaper", limit=24)
    print(page["total"], len(page["items"]))

    detail = client.get(page["items"][0]["slug"])
    result = client.download(detail["url"], "out.mp4", verify_sha=detail.get("sha256"))
    print(result["bytes"], result["sha256"][:12])

约定：HTTP 非 2xx 抛 `FoliaError`（带 status / code / hint），与 JS 客户端一致；
错误码表见 docs/API-V1.md。
"""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
import urllib.error
import urllib.parse
import urllib.request

__all__ = ["FoliaClient", "FoliaError"]

DEFAULT_BASE = "https://folia-5ve.pages.dev"


class FoliaError(Exception):
    """API 返回的错误（或网络层错误）。`code` 与 docs/API-V1.md 的错误码表一致。"""

    def __init__(self, status: int, code: str = "internal_error", message: str = "", hint: str = "",
                 details=None, url: str = ""):
        super().__init__(message or f"HTTP {status}")
        self.status = status
        self.code = code
        self.hint = hint
        self.details = details
        self.url = url

    @classmethod
    def from_body(cls, status: int, body, url: str = "") -> "FoliaError":
        error = (body or {}).get("error") or {}
        return cls(
            status=status,
            code=error.get("code", "internal_error"),
            message=error.get("message", f"HTTP {status}"),
            hint=error.get("hint", ""),
            details=error.get("details"),
            url=url,
        )


class FoliaClient:
    def __init__(self, base_url: str = DEFAULT_BASE, api_key: str = "", timeout: float = 30.0):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key or ""
        self.timeout = timeout

    # ------------------------------------------------------------------ 内部
    def _url(self, path: str, params: dict | None = None) -> str:
        url = f"{self.base_url}{path}"
        if params:
            clean = {}
            for key, value in params.items():
                if value is None or value == "":
                    continue
                clean[key] = ",".join(str(item) for item in value) if isinstance(value, (list, tuple)) else str(value)
            if clean:
                url += "?" + urllib.parse.urlencode(clean)
        return url

    def _headers(self, extra: dict | None = None) -> dict:
        headers = {"accept": "application/json", "user-agent": "folia-sdk-python/1.0"}
        if self.api_key:
            headers["authorization"] = f"Bearer {self.api_key}"
        if extra:
            headers.update(extra)
        return headers

    def _request(self, url: str, headers: dict | None = None):
        request = urllib.request.Request(url, headers=self._headers(headers))
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            # 304 不是错误：HTTPError 只是 urllib 对非 2xx 的统一表示
            if error.code == 304:
                return 304, b""
            body = error.read()
            try:
                parsed = json.loads(body.decode("utf-8")) if body else None
            except json.JSONDecodeError:
                parsed = None
            raise FoliaError.from_body(error.code, parsed, url) from None
        except urllib.error.URLError as error:
            raise FoliaError(0, "network_error", f"请求失败：{error.reason}", "检查网络或 base_url", url=url) from None

    def _json(self, path: str, params: dict | None = None, headers: dict | None = None):
        url = self._url(path, params)
        status, body = self._request(url, headers)
        if status == 304:
            return None
        return json.loads(body.decode("utf-8")) if body else None

    # ------------------------------------------------------------------ 公开 API
    def list(self, **params) -> dict:
        """列表。返回 data：items / total / facets / nextCursor …"""
        body = self._json("/api/v1/public/wallpapers", params)
        return (body or {}).get("data", body)

    def get(self, slug: str) -> dict | None:
        """单条详情（按 slug）。"""
        if not slug:
            raise ValueError("get(slug) 需要 slug")
        body = self._json(f"/api/v1/public/wallpapers/{urllib.parse.quote(slug, safe='')}")
        return ((body or {}).get("data") or {}).get("wallpaper")

    def manifest(self, etag: str | None = None) -> dict | None:
        """全量 manifest。带 etag 时 304 返回 None。"""
        headers = {"if-none-match": etag} if etag else None
        return self._json("/api/v1/public/manifest.json", None, headers)

    def download(self, url_or_key: str, dest: str, verify_sha=None, chunk_size: int = 1 << 20) -> dict:
        """流式下载到本地；`verify_sha` 传字符串时校验，不符抛 FoliaError。

        返回 `{"path", "bytes", "sha256"}`。
        """
        url = url_or_key if url_or_key.lower().startswith(("http://", "https://")) \
            else f"{self.base_url}/media/{url_or_key.lstrip('/')}"

        directory = os.path.dirname(os.path.abspath(dest))
        os.makedirs(directory, exist_ok=True)
        digest = hashlib.sha256()
        received = 0
        request = urllib.request.Request(url, headers=self._headers())

        try:
            response = urllib.request.urlopen(request, timeout=self.timeout)
        except urllib.error.HTTPError as error:
            body = error.read()
            try:
                parsed = json.loads(body.decode("utf-8")) if body else None
            except json.JSONDecodeError:
                parsed = None
            raise FoliaError.from_body(error.code, parsed, url) from None
        except urllib.error.URLError as error:
            raise FoliaError(0, "network_error", f"下载失败：{error.reason}", url=url) from None

        fd, tmp = tempfile.mkstemp(prefix=".folia-", dir=directory)
        try:
            with os.fdopen(fd, "wb") as handle, response:
                while True:
                    block = response.read(chunk_size)
                    if not block:
                        break
                    handle.write(block)
                    digest.update(block)
                    received += len(block)
            os.replace(tmp, dest)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

        sha256 = digest.hexdigest()
        if isinstance(verify_sha, str) and verify_sha and verify_sha != sha256:
            raise FoliaError(
                200,
                code="sha256_mismatch",
                message=f"sha256 不一致：期望 {verify_sha}，实际 {sha256}",
                hint="文件可能被截断或对象被覆盖，请重新获取 manifest 后重试。",
                url=url,
            )
        return {"path": dest, "bytes": received, "sha256": sha256}
