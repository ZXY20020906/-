/**
 * 变体 label / key 后缀的**唯一口径**测试。
 *
 * 守的是 2026-11 那次「4320×2160 的源缩进 1920 框变成 1920×960，label 被写成 960p」：
 * label 原来是「拿高度拼字符串」在 ingest / dto / storage / routes 四处各写一遍，
 * 现在只有 `src/core/variant-label.js` 一处，这个文件负责把那几条**必须成立**的规则钉住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VARIANT_KIND, VARIANT_LABEL, VARIANT_KEY_TAG,
  labelForVariant, needsVariant, specFromFileName, variantKeyTag, variantKind,
} from '../src/core/variant-label.js';
import { variantKey } from '../src/server/storage.js';
import { variantsDto } from '../src/server/dto.js';

const SHA = 'a1b2c3d4e5f60718'.padEnd(64, '0');

test('R4 核心回归：4320×2160 源的 1920×960 档 ⇒ label 必须是 1080p（不是 960p）', () => {
  // 2:1 的源装进 1920×1080 框，宽顶满、高只剩 960 —— 这是「1080p 档」，不是「960p 档」
  const spec = {
    width: 1920,
    height: 960,
    fps: 30,
    original: { width: 4320, height: 2160, fps: 60 },
  };
  assert.equal(variantKind(spec), VARIANT_KIND.DOWNSCALE);
  assert.equal(labelForVariant(spec), VARIANT_LABEL.DOWNSCALE);
  assert.equal(labelForVariant(spec), '1080p');

  // 竖屏同理：2160×4320 的源 ⇒ 1080×1920 档，仍然是 1080p 档
  assert.equal(
    labelForVariant({
      width: 1080, height: 1920, fps: 30, original: { width: 2160, height: 4320, fps: 60 },
    }),
    '1080p',
  );
});

test('R4 核心回归：3840×2160 的同分辨率降帧档 ⇒ label 是 4K30（不是 2160p）', () => {
  const spec = {
    width: 3840,
    height: 2160,
    fps: 30,
    original: { width: 3840, height: 2160, fps: 60 },
  };
  assert.equal(variantKind(spec), VARIANT_KIND.FPS);
  assert.equal(labelForVariant(spec), VARIANT_LABEL.FOUR_K30);
  assert.equal(labelForVariant(spec), '4K30');
});

test('R4 核心回归：缺 fps ⇒ 回落 `${height}p`（绝不猜成 4K30）', () => {
  const cases = [
    [{ width: 3840, height: 2160, original: { width: 3840, height: 2160, fps: 60 } }, '2160p'],
    [{ width: 3840, height: 2160, fps: null }, '2160p'],
    [{ height: 1440 }, '1440p'],
    [{}, 'alt'],
  ];
  for (const [spec, want] of cases) {
    assert.equal(labelForVariant(spec), want, `spec=${JSON.stringify(spec)}`);
  }
});

test('label 规则表：2K30 / <height>p30 / 显式 kind 优先', () => {
  // ≥1440 高的降帧档 ⇒ 2K30
  assert.equal(labelForVariant({
    width: 2560, height: 1440, fps: 30, original: { width: 2560, height: 1440, fps: 60 },
  }), '2K30');

  // 1440 以下的降帧档 ⇒ `<height>p30`
  assert.equal(labelForVariant({
    width: 2048, height: 1200, fps: 30, original: { width: 2048, height: 1200, fps: 60 },
  }), '1200p30');

  // 显式 kind 压过尺寸推断：写入方比推断更懂这一档（比如 1920 宽的同分辨率降帧档）
  assert.equal(labelForVariant({ kind: VARIANT_KIND.FPS, width: 1920, height: 1080, fps: 30 }), '1080p30');
  assert.equal(labelForVariant({ kind: VARIANT_KIND.DOWNSCALE, width: 3840, height: 2160 }), '1080p');

  // 帧率不是 30 的「降帧」不是降帧档：60fps 的 4K 档既不是 1080p 也不是 30fps 档
  assert.equal(labelForVariant({ width: 3840, height: 2160, fps: 60 }), '2160p');
});

test('key 后缀稳定：1080p / 30fps（历史对象长这样），认不出才用 alt', () => {
  assert.equal(variantKeyTag({ width: 1920, height: 960, fps: 30 }), '1080p');
  assert.equal(variantKeyTag({ width: 3840, height: 2160, fps: 30 }), '30fps');
  assert.equal(variantKeyTag({ height: 2160 }), 'alt');
  assert.equal(VARIANT_KEY_TAG.UNKNOWN, 'alt');

  // storage.variantKey 只调这一处口径：同分辨率降帧档不许写成 .2160p.mp4
  assert.equal(
    variantKey('wp_1', SHA, { width: 3840, height: 2160, fps: 30 }),
    `wallpapers/wp_1/${SHA.slice(0, 16)}.30fps.mp4`,
  );
  assert.equal(
    variantKey('wp_1', SHA, { width: 1920, height: 960, fps: 30 }),
    `wallpapers/wp_1/${SHA.slice(0, 16)}.1080p.mp4`,
  );
});

test('needsVariant：宽>1920 或 高>1080 或 fps>30 才需要变体', () => {
  assert.equal(needsVariant({ width: 1920, height: 1080, fps: 30 }), false);
  assert.equal(needsVariant({ width: 1921, height: 1080, fps: 30 }), true);
  assert.equal(needsVariant({ width: 1920, height: 1081, fps: 30 }), true);
  assert.equal(needsVariant({ width: 1920, height: 1080, fps: 60 }), true);
  // 探测不到 fps 不触发「降帧」这一路（probe-failed 会在合规体检里单独判）
  assert.equal(needsVariant({ width: 1920, height: 1080 }), false);
});

test('文件名 → 预期档位（后台把 xxx.1080p.mp4 与源文件一起多选时用）', () => {
  assert.deepEqual(specFromFileName('星野.1080p.mp4'), { kind: '1080p', height: 1080 });
  assert.deepEqual(specFromFileName('星野.30fps.mp4'), { kind: '30fps', height: null });
  assert.deepEqual(specFromFileName('星野.2160p.mp4'), { kind: '1080p', height: 2160 });
  assert.deepEqual(specFromFileName('星野.mp4'), { kind: null, height: null });
  assert.deepEqual(specFromFileName(undefined), { kind: null, height: null });
});

test('dto 与 ingest 同口径：老记录没有 label 时，dto 回落结果等于 labelForVariant()', () => {
  const specs = [
    { width: 1920, height: 960, fps: 30 },
    { width: 3840, height: 2160, fps: 30 },
    { width: 3840, height: 2160 },
    { width: 1920, height: 1080, fps: 30 },
    { width: 2560, height: 1440, fps: 30 },
  ];
  for (const spec of specs) {
    const [dto] = variantsDto({
      variants: JSON.stringify([{
        ...spec, key: `wallpapers/wp_1/${SHA.slice(0, 16)}.mp4`, bytes: 1024,
      }]),
    });
    assert.equal(
      dto.label,
      labelForVariant(spec),
      `dto 与 ingest 必须调同一个函数：spec=${JSON.stringify(spec)}`,
    );
  }
});

test('dto：存的 label 优先（4K30 原样出来），缺失才回落', () => {
  const [withLabel] = variantsDto({
    variants: JSON.stringify([{
      label: '4K30', width: 3840, height: 2160, fps: 30,
      key: 'wallpapers/wp_1/x.30fps.mp4', bytes: 1,
    }]),
  });
  assert.equal(withLabel.label, '4K30');

  const [noLabel] = variantsDto({
    variants: JSON.stringify([{
      width: 3840, height: 2160, fps: 30,
      key: 'wallpapers/wp_1/x.30fps.mp4', bytes: 1,
    }]),
  });
  assert.equal(noLabel.label, '4K30', '老库缺 label 时也要认出降帧档');
});
