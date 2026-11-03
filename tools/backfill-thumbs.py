"""给已有作品补缩略图：下载原图 → Pillow 缩到 640 宽 → 传回 /thumb。

浏览器上传时会自动生成缩略图，这个脚本只用于补齐历史数据。
用法：python tools/backfill-thumbs.py
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
QUALITY = 82


UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


def download(path: str) -> bytes:
    """取原图：必须带浏览器 UA，否则 Cloudflare 直接 403。"""
    req = urllib.request.Request(BASE + path, headers={"user-agent": UA, "referer": BASE + "/"})
    with urllib.request.urlopen(req, timeout=120) as response:
        return response.read()

def request(path: str, *, method: str = "GET", body: bytes | None = None,
            cookie: str = "", content_type: str = "application/json"):
    headers = {
        # Cloudflare 会拦 Python-urllib 的默认 UA，伪装成浏览器
        "user-agent": UA,
        "accept": "application/json, */*",
        # 写接口要求这个头（CSRF 防护），登录也要
        "x-folia-client": "admin",
    }
    if cookie:
        headers["cookie"] = cookie
    if body is not None:
        headers["content-type"] = content_type
    req = urllib.request.Request(BASE + path, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=120) as response:
        return response.status, response.read(), response.headers


def login() -> str:
    status, body, headers = request(
        "/api/auth/login",
        method="POST",
        body=json.dumps({"email": EMAIL, "password": PASSWORD}).encode(),
    )
    if status != 200:
        raise SystemExit(f"登录失败：{status} {body[:200]}")
    for value in headers.get_all("Set-Cookie") or []:
        if value.startswith("folia_session="):
            return value.split(";")[0]
    raise SystemExit("登录成功但没拿到 Cookie")


def main() -> int:
    cookie = login()
    status, body, _ = request("/api/admin/wallpapers?limit=200", cookie=cookie)
    items = json.loads(body)["data"]["items"]
    print(f"共 {len(items)} 件作品")

    done = skipped = failed = 0
    for item in items:
        if item.get("hasThumb"):
            skipped += 1
            continue
        if not item.get("url") or not (item.get("mime") or "").startswith("image/"):
            skipped += 1
            continue

        try:
            raw = download(item["url"])
            image = Image.open(io.BytesIO(raw)).convert("RGB")
            width, height = image.size
            if width > MAX_WIDTH:
                image = image.resize((MAX_WIDTH, round(height * MAX_WIDTH / width)), Image.LANCZOS)
            buffer = io.BytesIO()
            image.save(buffer, format="WEBP", quality=QUALITY)
            data = buffer.getvalue()

            status, _, _ = request(
                f"/api/admin/wallpapers/{item['id']}/thumb",
                method="PUT",
                body=data,
                cookie=cookie,
                content_type="image/webp",
            )
            print(f"  OK   {item['title'][:36]:38} {width}x{height} -> {image.size[0]}x{image.size[1]}  {len(data) // 1024}KB")
            done += 1
        except urllib.error.HTTPError as error:
            print(f"  FAIL {item['title'][:36]} HTTP {error.code}")
            failed += 1
        except Exception as error:  # noqa: BLE001
            print(f"  FAIL {item['title'][:36]} {error}")
            failed += 1

    print(f"\n补缩略图：成功 {done}，跳过 {skipped}，失败 {failed}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
