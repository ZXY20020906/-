#!/usr/bin/env python
"""最小示例：列 1080p 可播素材 → 详情 → 下载并校验 sha256 → manifest。

    python sdk/python/example.py
    FOLIA_BASE=http://127.0.0.1:8788 python sdk/python/example.py
    FOLIA_KEY=flk_xxx python sdk/python/example.py
"""
import os

from folia_client import FoliaClient, FoliaError

client = FoliaClient(
    os.environ.get("FOLIA_BASE", "https://folia-5ve.pages.dev"),
    api_key=os.environ.get("FOLIA_KEY", ""),
)

page = client.list(category="wallpaper", kind="dynamic", playable="1080p30", limit=3)
print(f"列表：total={page['total']}，本页 {len(page['items'])} 条")
for item in page["items"]:
    print(f"- {item['id']} {item['title']} {item.get('width')}x{item.get('height')}@{item.get('fps')}fps")

if page["items"]:
    detail = client.get(page["items"][0]["slug"])
    print("详情:", detail["slug"], "variants:", [v["label"] for v in detail.get("variants", [])])
    saved = client.download(detail["url"], os.path.join("downloads", f"{detail['slug']}.mp4"),
                            verify_sha=detail.get("sha256"))
    print(f"下载完成：{saved['bytes']} 字节，sha256={saved['sha256'][:12]}…")

manifest = client.manifest()
print(f"manifest：apiVersion={manifest['apiVersion']} total={manifest['total']} generatedAt={manifest['generatedAt']}")
if client.manifest(etag=f'"{manifest["etag"]}"') is None:
    print("manifest 未变化（304）")

try:
    client.get("this-slug-does-not-exist")
except FoliaError as error:
    print(f"预期内的错误：{error.status} {error.code} — {error}")
