/**
 * 「能不能播 / 能不能入库」的唯一判定（阶段二）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HARD_VIOLATIONS, PLAYABLE_LIMITS, SOFT_VIOLATIONS, isPlayable, isSoftOnly, variantReasonFor,
} from '../src/core/variant-reason.js';

test('软违规 → fps-60 / oversize / codec', () => {
  assert.equal(variantReasonFor([{ code: 'fps-too-high' }]), 'fps-60');
  assert.equal(variantReasonFor([{ code: 'too-wide' }]), 'oversize');
  assert.equal(variantReasonFor([{ code: 'too-tall' }, { code: 'too-many-pixels' }]), 'oversize');
  assert.equal(variantReasonFor([{ code: 'codec-unsupported' }]), 'codec');
  assert.equal(variantReasonFor([{ code: 'fps-too-high' }, { code: 'too-wide' }]), 'fps-60', 'fps 优先');
});

test('硬违规 → null（不许入库）', () => {
  for (const code of HARD_VIOLATIONS) {
    assert.equal(variantReasonFor([{ code }]), null, `${code} 必须硬失败`);
  }
  assert.equal(variantReasonFor([{ code: 'fps-too-high' }, { code: 'probe-failed' }]), null, '混合也按硬失败');
  assert.equal(variantReasonFor([{ code: 'something-unknown' }]), null, '未知违规按硬失败处理');
});

test('isSoftOnly 与软违规集合一致', () => {
  for (const code of SOFT_VIOLATIONS) assert.equal(isSoftOnly([{ code }]), true);
  for (const code of HARD_VIOLATIONS) assert.equal(isSoftOnly([{ code }]), false);
  assert.equal(isSoftOnly([]), false);
});

test('isPlayable：边界与编码', () => {
  assert.equal(isPlayable({ fps: 30, width: 1920, height: 1080, codec: 'h264' }), true);
  assert.equal(isPlayable({ fps: 29.97, width: 3840, height: 2160, codec: 'avc1' }), true);
  assert.equal(isPlayable({ fps: 30.1, width: 1920, height: 1080, codec: 'h264' }), true, '容差内');
  assert.equal(isPlayable({ fps: 60, width: 1920, height: 1080, codec: 'h264' }), false);
  assert.equal(isPlayable({ fps: 30, width: 4096, height: 2160, codec: 'h264' }), false, '超宽');
  assert.equal(isPlayable({ fps: 30, width: 5916, height: 2530, codec: 'h264' }), false, '超像素');
  assert.equal(isPlayable({ fps: 30, width: 1920, height: 1080, codec: 'hevc' }), false);
  assert.equal(isPlayable({ fps: 30, width: 1920, height: 1080, codec: 'avc1' }), true);
  assert.equal(isPlayable({}), false);
  assert.equal(PLAYABLE_LIMITS.maxPixels, 8_300_000);
});
