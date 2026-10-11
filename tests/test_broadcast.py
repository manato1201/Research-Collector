"""
ResearchBroadcast 連携(ResearchBroadcast_DESIGN.md)の回帰テスト。ネットワーク不要・標準ライブラリのみ。

    python -m unittest discover tests

- 要約の保存(§5 段階0)と、古い行との後方互換
- 取り込みの送信クライアント(§4.1): 対象の絞り込み・契約の項目・ローカル限定分野を送らない保険
"""

import os
import sys
import unittest
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import post_ingest as pi  # noqa: E402
from collectors._text import clean_title, make_summary, strip_html  # noqa: E402
from nbklm import articles_log, semantic_dedup  # noqa: E402

NOW = datetime(2026, 10, 11, 0, 0, 0, tzinfo=timezone.utc)


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def entry(**kw):
    base = {
        "url_hash": "0123456789abcdef", "url": "https://example.com/a", "title": "記事",
        "source_type": "unity", "platform": "zenn", "categories": ["game_dev_tech"],
        "label": "game_dev_tech", "keywords": [], "review": False, "status": "added",
        "published": "2026-10-10", "collected_at": iso(NOW - timedelta(hours=1)),
    }
    base.update(kw)
    return base


class TextCleaningTest(unittest.TestCase):
    def test_html_in_titles_is_removed(self):
        # 実データ: UEブログのタイトルに生のタグが混ざっていた
        self.assertEqual(clean_title("<p><em>Gears of War: E-Day</em> sees a return</p>"), "Gears of War: E-Day sees a return")
        self.assertEqual(strip_html("a &amp; b&nbsp;c"), "a & b c")

    def test_summary_is_short_and_plain(self):
        e = {"title": "T", "summary": "<p>" + "あ" * 300 + "</p>"}
        s = make_summary(e)
        self.assertLessEqual(len(s), 140)
        self.assertTrue(s.endswith("…"))
        self.assertNotIn("<", s)

    def test_no_summary_is_none_not_empty(self):
        self.assertIsNone(make_summary({"title": "T"}))           # フィードに無い(Hugging Face 等)
        self.assertIsNone(make_summary({"title": "T", "summary": "  "}))

    def test_summary_that_only_repeats_the_title_is_dropped(self):
        self.assertIsNone(make_summary({"title": "同じ文面", "summary": "同じ文面"}))


class SummaryInLogTest(unittest.TestCase):
    def test_summary_is_stored_for_normal_articles(self):
        e = articles_log.make_entry(
            {"url": "https://e.com/1", "title": "t", "url_hash": "h", "source_type": "unity",
             "platform": "zenn", "summary": "要約です"}, "added", ["game_dev_tech"])
        self.assertEqual((e["summary"], e["summary_src"]), ("要約です", "feed"))

    def test_old_format_entries_stay_readable(self):
        # 要約が無い記事は項目ごと省く = 古い行と同じ形(後方互換)
        e = articles_log.make_entry(
            {"url": "https://e.com/1", "title": "t", "url_hash": "h", "source_type": "unity", "platform": "zenn"},
            "added", ["game_dev_tech"])
        self.assertNotIn("summary", e)
        self.assertNotIn("summary_src", e)

    def test_x_posts_never_store_a_summary(self):
        # 設計 §5: X の投稿は本文を再掲載しない
        e = articles_log.make_entry(
            {"url": "https://x.com/u/status/1", "title": "t", "url_hash": "h", "source_type": "x_post",
             "platform": "x", "summary": "本文"}, "added", ["software_engineering"])
        self.assertNotIn("summary", e)


class TruncatedTitleDedupTest(unittest.TestCase):
    def test_distinct_changes_with_identical_truncated_titles_are_kept(self):
        # SideFX はタイトルを40文字で切る。先頭が同じでも要約が違えば別の変更
        a = {"title": "22.0.468: Added parameter help to the Karma...", "platform": "sidefx_changelog", "url": "a",
             "summary": "Added parameter help to the Karma Fur VOP for parameters shared with the hair node."}
        b = {"title": "22.0.468: Added parameter help to the Karma...", "platform": "sidefx_changelog", "url": "b",
             "summary": "Added parameter help to the Karma Ocean node, including the new spectrum controls."}
        keep, merged = semantic_dedup.group_near_duplicates([a, b])
        self.assertEqual((len(keep), len(merged)), (2, 0))

    def test_same_truncated_change_republished_is_still_merged(self):
        a = {"title": "22.0.467: The VDB Leaf Point COP supports I...", "platform": "sidefx_changelog", "url": "a",
             "summary": "The VDB Leaf Point COP supports Index attributes."}
        b = {**a, "url": "b"}
        keep, merged = semantic_dedup.group_near_duplicates([a, b])
        self.assertEqual((len(keep), len(merged)), (1, 1))


class IngestClientTest(unittest.TestCase):
    def test_only_recent_entries_are_sent(self):
        old = entry(url_hash="aaaaaaaaaaaaaaaa", collected_at=iso(NOW - timedelta(hours=100)))
        new = entry(url_hash="bbbbbbbbbbbbbbbb")
        batches, stats = pi.build_batches([old, new], {}, NOW, since_hours=36)
        self.assertEqual(stats["articles"], 1)
        self.assertEqual(batches[0]["articles"][0]["url_hash"], "bbbbbbbbbbbbbbbb")
        self.assertEqual(batches[0]["schema"], pi.SCHEMA_VERSION)

    def test_local_only_categories_are_never_sent(self):
        # ローカル限定の分野は articles_log に書かれない設計だが、混ざっても送らない(二重の保険)
        leak = entry(url_hash="cccccccccccccccc", categories=["some_local_only_category"])
        mixed = entry(url_hash="dddddddddddddddd", categories=["game_dev_tech", "some_local_only_category"])
        batches, stats = pi.build_batches([leak, mixed], {}, NOW)
        self.assertEqual((stats["articles"], stats["skipped_ineligible"]), (0, 2))
        self.assertEqual(batches, [])

    def test_non_http_urls_are_not_sent(self):
        batches, stats = pi.build_batches([entry(url="javascript:alert(1)")], {}, NOW)
        self.assertEqual(stats["skipped_ineligible"], 1)

    def test_x_post_summary_is_stripped_even_if_present(self):
        e = entry(source_type="x_post", categories=["software_engineering"], summary="本文", summary_src="feed")
        b, _ = pi.build_batches([e], {}, NOW)
        sent = b[0]["articles"][0]
        self.assertNotIn("summary", sent)
        self.assertNotIn("summary_src", sent)

    def test_only_contract_fields_are_sent(self):
        e = entry(internal_note="秘密", text="X本文")
        b, _ = pi.build_batches([e], {}, NOW)
        self.assertNotIn("internal_note", b[0]["articles"][0])
        self.assertNotIn("text", b[0]["articles"][0])

    def test_batches_are_split_and_run_status_is_attached(self):
        many = [entry(url_hash=f"{i:016x}", url=f"https://example.com/{i}") for i in range(250)]
        health = {"daily": {"run_at": "2026-10-10T21:01:56Z", "collected": 96, "new": 3, "failed_sources": 0,
                            "source_failures": [{"source": "x", "error": "secret-ish detail"}]}}
        batches, stats = pi.build_batches(many, health, NOW)
        self.assertEqual([len(b["articles"]) for b in batches], [100, 100, 50])
        self.assertEqual(batches[0]["run"]["collected"], 96)
        # 失敗の詳細(エラー文)は送らない。件数だけ
        self.assertNotIn("source_failures", batches[0]["run"])

    def test_token_is_only_sent_over_https_or_loopback(self):
        self.assertTrue(pi.allowed_url("https://worker.example.workers.dev/api/ingest"))
        self.assertTrue(pi.allowed_url("http://127.0.0.1:8787/api/ingest"))
        self.assertTrue(pi.allowed_url("http://localhost:8787/api/ingest"))
        self.assertFalse(pi.allowed_url("http://example.com/api/ingest"))
        self.assertFalse(pi.allowed_url("ftp://example.com/x"))


if __name__ == "__main__":
    unittest.main()
