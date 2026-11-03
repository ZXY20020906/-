"""把所有作品的封面统一压到 640px 宽、WebP、几十 KB。

背景：补封面时直接把 WE 的 preview.jpg 传了上去（最大 1MB），
作为卡片缩略图太重了，这里统一重压一遍。

用法：python tools/shrink-thumbs.py
"""
from __future__ import annotations

import os
import io
import json
import sys
import urllib.error
import urllib.request

from PIL import Image

BASE = "https://folia-5ve.pages.dev"
EMAIL = "admin@folia.local"
PASSWORD = os.environ.get("FOLIA_PASSWORD", "")
MAX_WIDTH = 640
QUALITY = 80
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


def request(path: str, *, method: str = "GET", body: bytes | None = None,
            cookie: str = "", content_type: str = "application/json"):
    headers = {"user-agent": UA, "accept": "application/json, */*", "x-folia-client": "admin"}
    if cookie:
        headers["cookie"] = cookie
    if body is not None:
        headers["content-type"] = content_type
    req = urllib.request.Request(BASE + path, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=180) as response:
        return response.status, response.read(), response.headers


def download(path: str) -> bytes:
    req = urllib.request.Request(BASE + path, headers={"user-agent": UA, "referer": BASE + "/"})
    with urllib.request.urlopen(req, timeout=180) as response:
        return response.read()


def main() -> int:
    status, body, headers = request(
        "/api/auth/login", method="POST",
        body=json.dumps({"email": EMAIL, "password": PASSWORD}).encode(),
    )
    cookie = ""
    for value in headers.get_all("Set-Cookie") or []:
        if value.startswith("folia_session="):
            cookie = value.split(";")[0]
    if not cookie:
        raise SystemExit("登录失败")

    _, body, _ = request("/api/admin/wallpapers?limit=300", cookie=cookie)
    items = json.loads(body)["data"]["items"]

    done = skipped = failed = 0
    for item in items:
        # 没有独立封面（thumbUrl 等于原图）就没什么可压的
        if not item.get("thumbUrl") or item["thumbUrl"] == item.get("url"):
            skipped += 1
            continue
        key = (item.get("thumbUrl") or "").replace("/media/", "")
        try:
            raw = download(item["thumbUrl"])
            image = Image.open(io.BytesIO(raw))
            if image.mode not in ("RGB", "RGBA"):
                image = image.convert("RGB")
            width, height = image.size
            if width > MAX_WIDTH:
                image = image.resize((MAX_WIDTH, round(height * MAX_WIDTH / width)), Image.LANCZOS)
            buffer = io.BytesIO()
            image.save(buffer, format="WEBP", quality=QUALITY, method=6)
            data = buffer.getvalue()
            if len(data) >= len(raw):
                skipped += 1
                continue
            request(f"/api/admin/wallpapers/{item['id']}/thumb", method="PUT",
                    body=data, cookie=cookie, content_type="image/webp")
            print(f"  OK  {len(raw)//1024:4}KB -> {len(data)//1024:3}KB  {item['title'][:34]}")
            done += 1
        except urllib.error.HTTPError as error:
            print(f"  FAIL {item['title'][:30]} HTTP {error.code}")
            failed += 1
        except Exception as error:  # noqa: BLE001
            print(f"  FAIL {item['title'][:30]} {error}")
            failed += 1

    print(f"\n压完：{done} 个，跳过 {skipped}，失败 {failed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
