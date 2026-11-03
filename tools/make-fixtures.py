"""生成图片测试夹具（真实文件，不是手搓字节），供 tests/image-meta.test.js 使用。"""
from pathlib import Path
from PIL import Image

OUT = Path(__file__).resolve().parent.parent / "tests" / "fixtures"
OUT.mkdir(parents=True, exist_ok=True)

cases = [
    ("sample.png", (4, 3), "PNG"),
    ("sample.jpg", (5, 2), "JPEG"),
    ("sample.gif", (7, 6), "GIF"),
    ("sample.webp", (8, 9), "WEBP"),
]

for name, size, fmt in cases:
    img = Image.new("RGB", size, (90, 60, 200))
    img.save(OUT / name, format=fmt)
    print(name, size, fmt)

# 无损 WebP（VP8L）走另一条解析分支
Image.new("RGB", (11, 13), (20, 120, 90)).save(OUT / "lossless.webp", format="WEBP", lossless=True)
print("lossless.webp", (11, 13), "WEBP lossless")
