"""ゲームメディア(電ファミニコゲーマー・ゲームメーカーズ)コレクターの単体テスト。ネットワークは使わない。"""
import os
import sys
import unittest
from datetime import datetime, timezone
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import feedparser  # noqa: E402

from collectors import game_media_collector as gm  # noqa: E402
from nbklm.classifier import classify  # noqa: E402
from nbklm.notebook_ids import SOURCE_TYPE_TO_CATEGORIES  # noqa: E402

RSS = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>t</title>{items}</channel></rss>"""
ITEM = """<item><title>{title}</title><link>{link}</link><pubDate>{date}</pubDate>
<description><![CDATA[{desc}]]></description></item>"""


def feed(*entries):
    items = "".join(ITEM.format(title=t, link=l, date=d, desc=s) for t, l, d, s in entries)
    return feedparser.parse(RSS.format(items=items))


E1 = ("ゲームの記事A", "https://example.com/a", "Wed, 04 Nov 2026 05:10:02 +0000", "<p>概要A。</p>" + "あ" * 300)
E2 = ("ゲームの記事B", "https://example.com/b", "Tue, 03 Nov 2026 05:10:02 +0000", "概要B")
E3 = ("ゲームの記事C", "https://example.com/c", "Mon, 02 Nov 2026 05:10:02 +0000", "概要C")


class GameMediaCollectorTest(unittest.TestCase):
    def test_both_sites_are_registered_with_rss_urls(self):
        by = {p: (u, s) for u, s, p, _ in gm.MEDIA_FEEDS}
        self.assertEqual(by["denfaminicogamer"], ("https://news.denfaminicogamer.jp/feed", "denfami"))
        self.assertEqual(by["gamemakers"], ("https://gamemakers.jp/feed/", "gamemakers"))

    def test_collect_builds_articles_with_a_short_summary_only(self):
        with mock.patch.object(gm, "fetch_feed", side_effect=lambda url: feed(E1, E2)):
            arts = gm.collect(max_per_feed=5)
        self.assertEqual(len(arts), 2)  # 2つの媒体で、同じ URL は 1 件(重複排除)
        a = arts[0]
        self.assertEqual((a["source_type"], a["platform"]), ("denfami", "denfaminicogamer"))
        self.assertEqual(a["url"], "https://example.com/a")
        self.assertEqual(len(a["url_hash"]), 16)
        self.assertTrue(a["summary"].startswith("概要A。"))
        self.assertLessEqual(len(a["summary"]), 140, "only a short excerpt is kept, never the body")
        self.assertNotIn("<p>", a["summary"])

    def test_the_per_feed_cap_is_applied(self):
        with mock.patch.object(gm, "fetch_feed", side_effect=lambda url: feed(E1, E2, E3)):
            arts = gm.collect(max_per_feed=1)
        self.assertEqual(len(arts), 1)

    def test_one_failing_site_does_not_stop_the_other(self):
        def fake(url):
            if "denfami" in url:
                raise RuntimeError("HTTP 503")
            return feed(E2)
        with mock.patch.object(gm, "fetch_feed", side_effect=fake), mock.patch.object(gm, "record_failure") as rec:
            arts = gm.collect()
        self.assertEqual([a["platform"] for a in arts], ["gamemakers"])
        rec.assert_called_once()
        self.assertEqual(rec.call_args[0][0], "https://news.denfaminicogamer.jp/feed")  # 失敗した収集元の URL が記録される

    def test_backfill_keeps_only_the_range(self):
        since, until = datetime(2026, 11, 3, tzinfo=timezone.utc), datetime(2026, 11, 4, 23, tzinfo=timezone.utc)
        with mock.patch.object(gm, "fetch_feed", side_effect=lambda url: feed(E1, E2, E3)):
            arts = gm.collect_backfill(since, until)
        self.assertEqual({a["url"] for a in arts}, {"https://example.com/a", "https://example.com/b"})

    def test_routed_to_game_dev_tech_only(self):
        self.assertEqual(SOURCE_TYPE_TO_CATEGORIES["denfami"], ["game_dev_tech"])
        self.assertEqual(SOURCE_TYPE_TO_CATEGORIES["gamemakers"], ["game_dev_tech"])

    def test_off_topic_news_from_denfami_is_sent_to_review_but_game_news_is_classified(self):
        film = classify("『ゴジラ』初日興行収入が歴代1位を記録", "", "denfami")
        self.assertEqual(film["label"], "none")  # ゲームと関係が無ければ「どれでもない」→ 要確認
        game = classify("インディーゲームのパブリッシングブランドを設立", "", "denfami")
        self.assertEqual(game["label"], "game_dev_tech")
        asset = classify("無料のアセットパックを公開", "", "gamemakers")
        self.assertEqual(asset["label"], "game_dev_tech")  # ゲームメーカーズは制作の媒体(事前情報あり)


if __name__ == "__main__":
    unittest.main()
