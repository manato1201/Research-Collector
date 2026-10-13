"""D1 のバックアップ(ページ取得・世代の整理・古さの判定・設定の読み込み)のテスト。ネットワークは使わない。"""
import gzip
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import backup_d1 as bk  # noqa: E402


class ExportTests(unittest.TestCase):
    def test_every_table_is_paged_until_next_is_none(self):
        calls = []

        def fetch(base, token, path):
            calls.append(path)
            table = path.split("table=")[1].split("&")[0]
            off = int(path.split("offset=")[1].split("&")[0])
            total = 450 if table == "articles" else 3
            n = max(0, min(bk.PAGE, total - off))
            rows = [{"table": table, "i": off + i} for i in range(n)]
            return {"rows": rows, "next": off + n if n == bk.PAGE else None}

        out = bk.export_all("https://w.example", "t", fetch=fetch)
        self.assertEqual(set(out), set(bk.TABLES))
        self.assertEqual(len(out["articles"]), 450)
        self.assertEqual(len(out["board"]), 3)
        self.assertEqual(sum("table=articles" in c for c in calls), 3)  # 200 + 200 + 50

    def test_runaway_paging_is_bounded(self):
        out = bk.export_all("b", "t", fetch=lambda *a: {"rows": [{}], "next": 1})
        self.assertLessEqual(len(out["articles"]), 500)


class FilesTests(unittest.TestCase):
    def test_write_prune_and_age(self):
        with tempfile.TemporaryDirectory() as d:
            for day in range(1, 11):
                bk.write_backup({"articles": [{"a": day}]}, d, now=datetime(2026, 10, day, tzinfo=timezone.utc))
            removed = bk.prune(d, keep=8)
            self.assertEqual(len(removed), 2)
            self.assertEqual(len([f for f in os.listdir(d)]), 8)
            newest = os.path.join(d, "research-broadcast-2026-10-10.json.gz")
            with gzip.open(newest, "rt", encoding="utf-8") as f:
                data = json.load(f)
            self.assertEqual(data["counts"]["articles"], 1)
            self.assertEqual(data["tables"]["articles"][0]["a"], 10)
            age = bk.latest_backup_age_days(d, now=os.path.getmtime(newest) + 3 * 86400)
            self.assertAlmostEqual(age, 3, places=3)
            self.assertIsNone(bk.latest_backup_age_days(os.path.join(d, "none")))


class ConfigTests(unittest.TestCase):
    def test_env_wins_and_ingest_suffix_is_stripped(self):
        base, tok = bk.load_config({"BROADCAST_INGEST_URL": "https://w.example/api/ingest", "BROADCAST_INGEST_TOKEN": "t"}, root="/nonexistent")
        self.assertEqual((base, tok), ("https://w.example", "t"))

    def test_nothing_configured_gives_empty(self):
        self.assertEqual(bk.load_config({}, root="/nonexistent"), ("", ""))

    def test_reads_the_local_secrets_file(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "broadcast"))
            with open(os.path.join(d, "broadcast", ".deploy-secrets.txt"), "w", encoding="utf-8") as f:
                f.write("URL=https://w.example\nINGEST_TOKEN=abc   # comment\n")
            self.assertEqual(bk.load_config({}, root=d), ("https://w.example", "abc"))


if __name__ == "__main__":
    unittest.main()
