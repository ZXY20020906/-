"""生成示例壁纸（纯渐变，无文字），让每个 tab 有内容、也能演示不同宽高比。"""
from pathlib import Path

import os
import numpy as np
from PIL import Image

OUT = Path(__file__).resolve().parent.parent / "deploy" / ".seed"
OUT.mkdir(parents=True, exist_ok=True)

# (宽, 高, 起始色, 结束色)
CASES = [
    (1920, 1080, (12, 14, 30), (86, 60, 180)),
    (1920, 1080, (8, 24, 28), (24, 160, 140)),
    (1080, 1920, (18, 12, 28), (200, 90, 120)),
    (1920, 1080, (24, 18, 10), (220, 150, 60)),
]

for index, (width, height, start, end) in enumerate(CASES, start=1):
    y = np.linspace(0.0, 1.0, height, dtype=np.float32)[:, None]
    x = np.linspace(0.0, 1.0, width, dtype=np.float32)[None, :]
    t = np.clip((x * 0.35 + y * 0.65), 0.0, 1.0)[..., None]
    start_arr = np.array(start, dtype=np.float32)
    end_arr = np.array(end, dtype=np.float32)
    rgb = start_arr * (1.0 - t) + end_arr * t

    # 加一点暗角，看起来像壁纸而不是色块
    cy, cx = 0.5, 0.5
    dist = np.sqrt((x - cx) ** 2 + (y - cy) ** 2)[..., None]
    rgb = rgb * (1.0 - np.clip(dist * 0.55, 0.0, 0.45))

    image = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), mode="RGB")
    name = f"still-{index}.jpg"
    image.save(OUT / name, format="JPEG", quality=88)
    print(name, width, height)
