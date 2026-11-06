/**
 * 阶段六 · 运维三件套的**纯逻辑**单测（不打网络）。
 *
 * 三个脚本真正的风险不在「能不能跑」，而在「判定对不对」：
 * 对象缺失要判成 missing、大小不符要能算出差值、导出文件的自检要能发现条数对不上。
 * 这些都用构造数据覆盖；真正连 D1/R2 的路径由线上验收（inspect 对生产、export 对真库）验证。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyAssetRow, summarize, formatTable } from '../tools/inspect-assets.mjs';
import { TABLES, buildExport, verifyExport } from '../tools/export-d1.mjs';

test('inspect：classifyAssetRow 的四种判定', () => {
  assert.deepEqual(classifyAssetRow({ storage_key: null }, null), { state: 'no-asset' });
  assert.equal(classifyAssetRow({ storage_key: 'k', bytes: 10 }, null).state, 'missing');
  const size = classifyAssetRow({ storage_key: 'k', bytes: 10 }, { size: 12 });
  assert.equal(size.state, 'size-mismatch');
  assert.equal(size.expected, 10);
  assert.equal(size.actual, 12);
  assert.equal(classifyAssetRow({ storage_key: 'k', bytes: 10 }, { size: 10 }).state, 'ok');
  // bytes 未知（0）时不做大小判定：老数据里 bytes=0 很常见，不该天天报错
  assert.equal(classifyAssetRow({ storage_key: 'k', bytes: 0 }, { size: 999 }).state, 'ok');
});

test('inspect：summarize —— 有缺失就 exit 1，全一致 exit 0', () => {
  const clean = summarize({
    checked: [
      { id: 'wp_1', state: 'ok' },
      { id: 'wp_2', state: 'no-asset' },
    ],
    counts: { needsVariant: 0, oldDrafts: 0 },
  });
  assert.equal(clean.ok, true);
  assert.equal(clean.exitCode, 0);
  assert.equal(clean.counts.withAsset, 1);
  assert.equal(clean.counts.noAsset, 1);

  const broken = summarize({
    checked: [
      { id: 'wp_1', state: 'ok' },
      { id: 'wp_2', state: 'missing', key: 'wallpapers/wp_2/x.mp4' },
      { id: 'wp_3', state: 'size-mismatch', key: 'wallpapers/wp_3/y.mp4', expected: 1, actual: 2 },
    ],
    counts: {},
  });
  assert.equal(broken.ok, false);
  assert.equal(broken.exitCode, 1);
  assert.equal(broken.problems.length, 2);
  assert.equal(broken.counts.missing, 1);
  assert.equal(broken.counts.sizeMismatch, 1);
});

test('inspect：阈值只有显式开启才影响退出码', () => {
  const base = { checked: [{ id: 'wp_1', state: 'ok' }], tmpObjects: [{ key: '_tmp/a', lastModified: new Date().toISOString() }] };
  const silent = summarize({ ...base, counts: { needsVariant: 9, oldDrafts: 9 } });
  assert.equal(silent.exitCode, 0, '默认不因为堆积/残留而红');

  const strict = summarize({
    ...base,
    counts: { needsVariant: 9, oldDrafts: 9 },
    thresholds: { maxNeedsVariant: 3, maxOldDrafts: 3, maxTmp: 0 },
  });
  assert.equal(strict.exitCode, 1);
  assert.equal(strict.breaches.length, 2);
  assert.match(strict.breaches.join('|'), /needs_variant/);
});

test('inspect：_tmp/ 里超过 24h 的才算「残留」', () => {
  const now = Date.parse('2026-11-06T12:00:00Z');
  const report = summarize({
    checked: [],
    tmpObjects: [
      { key: '_tmp/old', lastModified: '2026-11-05T00:00:00Z' },
      { key: '_tmp/new', lastModified: '2026-11-06T11:30:00Z' },
    ],
    now,
  });
  assert.equal(report.counts.tmpObjects, 2);
  assert.equal(report.counts.tmpStale, 1);
  assert.equal(report.tmpStale[0].key, '_tmp/old');
});

test('inspect：表格输出里能读到关键结论', () => {
  const report = summarize({
    checked: [{ id: 'wp_1', state: 'missing', key: 'wallpapers/wp_1/x.mp4' }],
    counts: { needsVariant: 0, oldDrafts: 0, hiddenMissing: 110, scope: 'live' },
  });
  const text = formatTable(report);
  assert.match(text, /对象缺失\s+1/);
  assert.match(text, /hidden 中缺对象/);
  assert.match(text, /\[missing\]/);
});

test('export：buildExport 的条数自洽，verifyExport 能抓到不一致', () => {
  const document = buildExport({
    tables: { wallpapers: [{ id: 'wp_1' }], categories: [] },
    counts: { wallpapers: 1, categories: 0 },
    generatedAt: 1_760_000_000_000,
    databaseId: 'db_test',
  });
  assert.equal(document.totalRows, 1);
  assert.equal(document.generatedAtIso, new Date(1_760_000_000_000).toISOString());
  assert.equal(verifyExport(document).ok, true);

  const tampered = JSON.parse(JSON.stringify(document));
  tampered.counts.wallpapers = 2;
  const result = verifyExport(tampered);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('|'), /wallpapers 条数不符/);

  const noTables = verifyExport({ counts: {} });
  assert.equal(noTables.ok, false);
  assert.match(noTables.errors.join('|'), /tables/);
});

test('export：api_keys 的导出列不含 key_hash（不把令牌哈希带进备份）', () => {
  const columns = TABLES.api_keys.columns ?? '*';
  assert.ok(!columns.includes('key_hash'));
  assert.match(columns, /id, label, rpm, active/);
});
