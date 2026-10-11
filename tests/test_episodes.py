"""
episode(番組表)の生成と、その送信(ResearchBroadcast_DESIGN.md §2・§4)の回帰テスト。ネットワーク不要。

    python -m unittest discover tests
"""

import os
import sys
import unittest
from datetime import date, datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import post_ingest as pi  # noqa: E402
from nbklm import episodes as ep  # noqa: E402

JST = timezone(timedelta(hours=9))
NOW = datetime(2026, 10, 11, 9, 0, 0, tzinfo=timezone.utc)  # JST 2026-10-11 18:00


def iso_jst(day: str, hour: int = 7) -> str:
    """JSTの日時を、記事ログの形式(UTC)で返す。"""
    y, m, d = (int(x) for x in day.split("-"))
    dt = datetime(y, m, d, hour, 0, 0, tzinfo=JST).astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


_n = 0


def art(day="2026-10-11", cats=("game_dev_tech",), title=None, **kw):
    global _n
    _n += 1
    base = {
        "url_hash": f"{_n:016x}", "url": f"https://example.com/{_n}", "title": title or f"記事{_n}",
        "source_type": "unity", "platform": "zenn", "categories": list(cats), "label": cats[0],
        "keywords": [], "review": False, "status": "added", "published": day,
        "collected_at": iso_jst(day),
    }
    base.update(kw)
    return base


class DailyTest(unittest.TestCase):
    def test_empty_day_makes_no_episode(self):
        # 早朝の実行で「今日」が空の番組になり、直前の内容を上書きしないように
        self.assertEqual(ep.build_daily([art(day="2026-10-10")], "2026-10-11"), [])

    def test_counts_are_per_url_and_multi_category_items_appear_in_both_lanes(self):
        both = art(cats=("game_dev_tech", "graphics_research"), title="両方に入る記事")
        only = art(cats=("software_engineering",), title="SEだけ")
        eps = {e["category"]: e for e in ep.build_daily([both, only], "2026-10-11")}
        all_ep = eps[None]
        self.assertEqual(all_ep["data"]["counts"]["total"], 2)                       # URL単位
        self.assertEqual(all_ep["data"]["counts"]["by_category"]["game_dev_tech"], 1)
        self.assertEqual(all_ep["data"]["counts"]["by_category"]["graphics_research"], 1)
        titles = lambda c: [i["title"] for i in eps[c]["data"]["items"]]
        self.assertIn("両方に入る記事", titles("game_dev_tech"))
        self.assertIn("両方に入る記事", titles("graphics_research"))
        badge = eps["game_dev_tech"]["data"]["items"][0]["other_categories"]
        self.assertEqual(badge, ["graphics_research"])   # 「ほかのカテゴリにも」バッジの元

    def test_failed_and_merged_articles_are_not_broadcast(self):
        eps = ep.build_daily([art(status="failed"), art(status="merged"), art(title="残る記事")], "2026-10-11")
        items = [i["title"] for e in eps if e["category"] == "game_dev_tech" for i in e["data"]["items"]]
        self.assertEqual(items, ["残る記事"])

    def test_local_only_categories_are_never_included(self):
        leak = art(cats=("game_dev_tech", "some_local_only_category"), title="混入")
        self.assertEqual(ep.build_daily([leak], "2026-10-11"), [])

    def test_x_post_has_no_summary(self):
        x = art(source_type="x_post", platform="x", cats=("software_engineering",), summary="本文", title="X投稿")
        e = [e for e in ep.build_daily([x], "2026-10-11") if e["category"] == "software_engineering"][0]
        self.assertNotIn("summary", e["data"]["items"][0])

    def test_official_sources_come_first_then_newer(self):
        a = art(platform="zenn", title="個人記事", published="2026-10-11")
        b = art(platform="unity_blog", title="公式ブログ", published="2026-10-10")
        e = [e for e in ep.build_daily([a, b], "2026-10-11") if e["category"] == "game_dev_tech"][0]
        self.assertEqual([i["title"] for i in e["data"]["items"]], ["公式ブログ", "個人記事"])

    def test_ids_are_stable_so_resending_is_idempotent(self):
        entries = [art(title="a"), art(cats=("graphics_research",), title="b")]
        ids1 = [e["id"] for e in ep.build_daily(entries, "2026-10-11")]
        ids2 = [e["id"] for e in ep.build_daily(list(reversed(entries)), "2026-10-11")]
        self.assertEqual(sorted(ids1), sorted(ids2))
        self.assertIn("daily:2026-10-11:all", ids1)
        self.assertIn("daily:2026-10-11:game_dev_tech", ids1)

    def test_day_boundary_uses_jst(self):
        # JST 2026-10-11 00:30 = UTC 2026-10-10 15:30 → 「10-11」の番組に入る
        e = art(day="2026-10-11")
        e["collected_at"] = "2026-10-10T15:30:00Z"
        self.assertEqual(len(ep.build_daily([e], "2026-10-11")) > 0, True)
        self.assertEqual(ep.build_daily([e], "2026-10-10"), [])

    def test_item_limit(self):
        many = [art(title=f"記事 {i} " + "x" * 5) for i in range(ep.ITEM_LIMIT + 10)]
        e = [e for e in ep.build_daily(many, "2026-10-11") if e["category"] == "game_dev_tech"][0]
        self.assertEqual(len(e["data"]["items"]), ep.ITEM_LIMIT)
        self.assertEqual(e["data"]["count"], ep.ITEM_LIMIT + 10)   # 件数は切らない


class WeeklyTest(unittest.TestCase):
    def test_week_days_and_label(self):
        self.assertEqual(ep.week_label(date(2026, 10, 11)), "2026-W41")
        days = ep.week_days("2026-W41")
        self.assertEqual((days[0], days[6]), ("2026-10-05", "2026-10-11"))   # 月〜日
        # 年をまたぐISO週: 2026-12-31 は 2026-W53
        self.assertEqual(ep.week_label(date(2026, 12, 31)), "2026-W53")
        self.assertEqual(ep.week_label(date(2027, 1, 1)), "2026-W53")

    def test_weekly_series_chapters_and_counts(self):
        entries = [
            art(day="2026-10-05", cats=("game_dev_tech",)),
            art(day="2026-10-05", cats=("game_dev_tech", "graphics_research")),
            art(day="2026-10-09", cats=("software_engineering",)),
            art(day="2026-10-12", cats=("game_dev_tech",)),     # 翌週: 入らない
        ]
        [w] = ep.build_weekly(entries, "2026-W41")
        d = w["data"]
        self.assertEqual(w["id"], "weekly:2026-W41:all")
        self.assertEqual(d["counts"]["total"], 3)
        self.assertEqual(len(d["daily"]), 7)
        self.assertEqual(d["daily"][0]["total"], 2)             # 月曜
        self.assertEqual(sum(r["total"] for r in d["daily"]), 3)
        ch = {c["category"]: c for c in d["chapters"]}
        self.assertEqual(ch["game_dev_tech"]["count"], 2)
        self.assertEqual(ch["graphics_research"]["count"], 1)
        self.assertEqual(ch["software_engineering"]["count"], 1)

    def test_empty_week_makes_no_episode(self):
        self.assertEqual(ep.build_weekly([], "2026-W41"), [])


class RunTest(unittest.TestCase):
    def test_build_for_run_covers_today_yesterday_and_two_weeks(self):
        entries = [art(day="2026-10-11"), art(day="2026-10-10"), art(day="2026-10-02")]
        ids = {e["id"] for e in ep.build_for_run(entries, NOW)}
        self.assertIn("daily:2026-10-11:all", ids)
        self.assertIn("daily:2026-10-10:all", ids)
        self.assertIn("weekly:2026-W41:all", ids)
        self.assertIn("weekly:2026-W40:all", ids)        # 10-02 は先週


class IngestEpisodesTest(unittest.TestCase):
    def _entry(self):
        return art(collected_at=(NOW - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ"))

    def test_episodes_and_failures_ride_only_on_the_first_batch(self):
        many = [art(collected_at=(NOW - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")) for _ in range(150)]
        health = {"daily": {"source_failures": [{"source": "https://x/feed", "error": "HTTP 404"}]}}
        eps = ep.build_for_run(many, NOW)
        batches, stats = pi.build_batches(many, health, NOW, episodes=eps)
        self.assertEqual(len(batches), 2)
        self.assertIn("episodes", batches[0])
        self.assertNotIn("episodes", batches[1])
        self.assertEqual(batches[0]["failures"], [{"source": "https://x/feed", "error": "HTTP 404"}])
        self.assertEqual(stats["episodes"], len(eps))

    def test_episode_only_batch_when_no_recent_articles(self):
        old = art(day="2026-10-11")
        old["collected_at"] = (NOW - timedelta(hours=200)).strftime("%Y-%m-%dT%H:%M:%SZ")
        batches, stats = pi.build_batches([old], {}, NOW, since_hours=36,
                                          episodes=[{"id": "daily:2026-10-11:all", "kind": "daily"}])
        self.assertEqual(len(batches), 1)
        self.assertEqual(batches[0]["articles"], [])
        self.assertEqual(len(batches[0]["episodes"]), 1)

    def test_failure_text_is_truncated(self):
        health = {"daily": {"source_failures": [{"source": "s" * 500, "error": "e" * 500}]}}
        f = pi.build_failures(health)[0]
        self.assertEqual((len(f["source"]), len(f["error"])), (120, 200))


if __name__ == "__main__":
    unittest.main()
