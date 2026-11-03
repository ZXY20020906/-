from __future__ import annotations
import os
import json, os, sys
from PIL import Image

d = "build/stills"
rows = []
for name in sorted(os.listdir(d)):
    if not name.lower().endswith((".jpg", ".png")):
        continue
    path = os.path.join(d, name)
    im = Image.open(path)
    fmt = im.format
    w, h = im.size
    alpha_ratio = 0.0
    if im.mode in ("RGBA", "LA"):
        alpha = im.getchannel("A")
        hist = alpha.histogram()
        transparent = sum(hist[:8])            # 近全透明
        alpha_ratio = transparent / (w * h)
    rows.append({"file": name, "format": fmt, "w": w, "h": h,
                 "mb": round(os.path.getsize(path) / 1048576, 2),
                 "alpha": round(alpha_ratio, 3)})

rows.sort(key=lambda r: -r["alpha"])
print(f"{'文件':<12} {'格式':<5} {'尺寸':<12} {'MB':>6} {'透明占比':>8}  判定")
for r in rows:
    verdict = "图集/图层（透明多）" if r["alpha"] > 0.15 else "成图"
    print(f"{r['file']:<12} {r['format']:<5} {str(r['w'])+'x'+str(r['h']):<12} {r['mb']:>6} {r['alpha']:>8.1%}  {verdict}")

with open("build/stills-analysis.json", "w", encoding="utf8") as f:
    json.dump(rows, f, ensure_ascii=False, indent=2)
print("\n已写 build/stills-analysis.json")
