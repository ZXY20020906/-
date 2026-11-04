/** 把 src/server/queries.js 里的全部 SQL 导出成 JSON，供 tools/check-sql.py 用真实 sqlite3 校验。 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Q, PUBLIC_FACETS, PUBLIC_LIST_BY_SORT, PUBLIC_SUBTAGS } from '../src/server/queries.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'build');
mkdirSync(outDir, { recursive: true });

const payload = {
  ...Q,
  // 独立导出的查询也要进 dump，否则 check-sql.py 校验不到它们
  publicFacets: PUBLIC_FACETS,
  publicSubtags: PUBLIC_SUBTAGS,
  ...Object.fromEntries(Object.entries(PUBLIC_LIST_BY_SORT).map(([k, v]) => [`publicList:${k}`, v])),
};
writeFileSync(resolve(outDir, 'queries.json'), JSON.stringify(payload, null, 2), 'utf8');

const names = Object.keys(payload);
const noSqliteKeywords = names.filter((name) => /insert|update|delete/i.test(payload[name]));
console.log(`wrote ${names.length} queries → build/queries.json (${noSqliteKeywords.length} write statements)`);
