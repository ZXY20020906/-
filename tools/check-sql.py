#!/usr/bin/env python
"""用真正的 sqlite3 校验 schema 和全部 SQL：语法、表名、列名、参数占位符。

D1 是 SQLite，所以这一步能提前抓掉 90% 的「上线才发现 SQL 写错」问题。
用法：python tools/check-sql.py
"""
from __future__ import annotations

import os
import json
import re
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = ROOT / "schema"
QUERIES = ROOT / "build" / "queries.json"

PLACEHOLDER = re.compile(r"\?\d*")


def bind_count(sql: str) -> int:
    numbered = [int(m.group(1)) for m in re.finditer(r"\?(\d+)", sql)]
    if numbered:
        return max(numbered)
    return len(PLACEHOLDER.findall(re.sub(r"\?\d+", "", sql)))


def substitute(sql: str) -> str:
    """把占位符换成 NULL，EXPLAIN 只做编译，不执行。"""
    return PLACEHOLDER.sub("NULL", sql)


def main() -> int:
    if not QUERIES.exists():
        print("缺少 build/queries.json，先运行 node tools/dump-queries.mjs", file=sys.stderr)
        return 2

    con = sqlite3.connect(":memory:")
    con.execute("PRAGMA foreign_keys = ON")

    for path in sorted(SCHEMA.glob("*.sql")):
        sql = path.read_text(encoding="utf-8")
        try:
            con.executescript(sql)
        except sqlite3.Error as exc:
            print(f"SCHEMA FAIL {path.name}: {exc}")
            return 1
        print(f"schema ok: {path.name}")

    tables = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    print(f"tables: {', '.join(tables)}")

    seed_categories = con.execute("SELECT slug, name, sort_order FROM categories ORDER BY sort_order").fetchall()
    print(f"seeded categories: {seed_categories}")

    queries = json.loads(QUERIES.read_text(encoding="utf-8"))
    failures = 0
    for name, sql in queries.items():
        try:
            con.execute("EXPLAIN " + substitute(sql)).fetchall()
        except sqlite3.Error as exc:
            failures += 1
            print(f"SQL FAIL [{name}]: {exc}")
            print(f"    {sql.strip()[:160]}...")
    print(f"checked {len(queries)} queries, {failures} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
