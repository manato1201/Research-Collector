"""週次の「今週のキーワード」(先週との差)のテスト。"""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from nbklm import episodes as ep  # noqa: E402


def entry(i, title, day="2026-10-07", cats=("game_dev_tech",), keywords=None):
    return {
        "url_hash": f"{i:016x}", "url": f"https://example.com/{i}", "title": title,
        "source_type": "unity", "platform": "zenn", "categories": list(cats), "status": "added",
        "collected_at": f"{day}T03:00:00Z", "published": day, "keywords": keywords or [],
    }


class TokenTests(unittest.TestCase):
    def test_english_and_katakana_words_are_topics_but_stop_words_are_not(self):
        t = ep._tokens(entry(1, "Added new Houdini PCG tools for the レンダリング最適化 テクスチャストリーミング"))
        self.assertIn("houdini", t)
        self.assertIn("pcg", t)
        self.assertIn("テクスチャストリーミング", t)
        self.assertNotIn("added", t)
        self.assertNotIn("new", t)
        self.assertNotIn("the", t)

    def test_versions_and_numbers_are_not_words(self):
        t = ep._tokens(entry(1, "22.0.468: Houdini 20.5 update"))
        self.assertEqual(t, {"houdini"})

    def test_hyphenated_and_dotted_terms_are_kept_whole(self):
        t = ep._tokens(entry(1, "WebGPU compute shaders in three.js and ray-tracing"))
        self.assertIn("webgpu", t)
        self.assertIn("three.js", t)
        self.assertIn("ray-tracing", t)

    def test_source_keywords_are_not_counted(self):
        t = ep._tokens(entry(1, "Plain title", keywords=["source:zenn", "rendergraph"]))
        self.assertIn("rendergraph", t)
        self.assertNotIn("source:zenn", t)


class WeekKeywordsTests(unittest.TestCase):
    def test_new_words_come_first_and_are_flagged(self):
        this_week = [entry(i, "Houdini PCG の新機能", day="2026-10-07") for i in range(1, 4)] + \
                    [entry(10 + i, "RenderGraph の解説", day="2026-10-08") for i in range(3)]
        last_week = [entry(100 + i, "RenderGraph の入門", day="2026-09-30") for i in range(3)]
        rows = ep.week_keywords(this_week, last_week)
        words = {r["word"].lower(): r for r in rows}
        self.assertTrue(words["houdini"]["new"])
        self.assertFalse(words["rendergraph"]["new"])
        self.assertEqual(words["rendergraph"]["prev"], 3)
        self.assertEqual(rows[0]["new"], True)  # 新出が先

    def test_singletons_are_dropped_when_the_week_has_enough_articles(self):
        entries = [entry(i, "Houdini の話") for i in range(6)] + [entry(50, "Zebracorn の話")]
        words = [r["word"].lower() for r in ep.week_keywords(entries, [])]
        self.assertIn("houdini", words)
        self.assertNotIn("zebracorn", words)

    def test_singletons_are_kept_when_the_week_is_small(self):
        words = [r["word"].lower() for r in ep.week_keywords([entry(1, "Zebracorn の話")], [])]
        self.assertIn("zebracorn", words)

    def test_result_is_deterministic_and_capped(self):
        entries = [entry(i, f"alpha{i % 20} beta{i % 20} gamma{i % 20}") for i in range(80)]
        a = ep.week_keywords(entries, [])
        b = ep.week_keywords(list(reversed(entries)), [])
        self.assertEqual(a, b)
        self.assertLessEqual(len(a), 12)

    def test_the_same_article_counts_once(self):
        e = entry(1, "Houdini Houdini Houdini")
        rows = ep.week_keywords([e, e], [])
        self.assertEqual({r["word"].lower(): r["count"] for r in rows}["houdini"], 1)


class WeeklyEpisodeTests(unittest.TestCase):
    def test_weekly_data_carries_keywords_and_prev_total(self):
        entries = [entry(i, "Houdini PCG", day="2026-10-07") for i in range(1, 4)] + \
                  [entry(20 + i, "RenderGraph", day="2026-09-30") for i in range(2)]
        eps = ep.build_weekly(entries, "2026-W41")
        data = eps[0]["data"]
        self.assertEqual(data["prev_total"], 2)
        self.assertTrue(any(k["word"].lower() == "houdini" and k["new"] for k in data["keywords"]))


if __name__ == "__main__":
    unittest.main()
