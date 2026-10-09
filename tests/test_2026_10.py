"""
2026-10 の改善(IMPROVEMENT_PLAN_2026-10.md)の回帰テスト。ネットワーク不要・標準ライブラリのみ。

    python -m unittest discover tests

実データで見つけた落とし穴(連載の誤統合・OS別記事の誤統合・外部入力のエスケープ等)を固定する。
"""

import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from nbklm import semantic_dedup  # noqa: E402
from nbklm.classifier import NONE_LABEL, classify  # noqa: E402
from collectors import release_notes_collector as rn  # noqa: E402
from collectors import x_posts_collector as xc  # noqa: E402
from collectors import watch_collector as wc  # noqa: E402


def art(title, url, platform="zenn"):
    return {"title": title, "url": url, "platform": platform}


class SemanticDedupTest(unittest.TestCase):
    def test_series_posts_are_not_merged(self):
        # 実データ: 「入門者Houdini勉強譚その1〜4」は数字1桁の違いで類似度1.0になっていた
        items = [art(f"入門者Houdini勉強譚その{i}", f"u{i}") for i in range(1, 5)]
        keep, merged = semantic_dedup.group_near_duplicates(items)
        self.assertEqual(len(keep), 4)
        self.assertEqual(merged, [])

    def test_version_numbers_are_not_merged(self):
        items = [art("Unity 6.1 の新機能まとめ", "a"), art("Unity 6.2 の新機能まとめ", "b")]
        keep, merged = semantic_dedup.group_near_duplicates(items)
        self.assertEqual((len(keep), len(merged)), (2, 0))

    def test_cross_post_is_merged_into_higher_priority(self):
        title = "プロシージャル生成で「無限のコンテンツ」は本当に作れるのか"
        keep, merged = semantic_dedup.group_near_duplicates(
            [art(title, "qiita-url", "qiita"), art(title, "zenn-url", "zenn")]
        )
        # 優先順位は同じ(個人記事)なので入力順が先のものが代表になる
        self.assertEqual([k["url"] for k in keep], ["qiita-url"])
        self.assertEqual(merged[0]["merged_into"], "qiita-url")

    def test_official_source_wins_as_representative(self):
        title = "Retrieval Augmented Generation for Tutorial Authoring"
        keep, merged = semantic_dedup.group_near_duplicates(
            [art(title, "s2", "semantic_scholar"), art(title, "arxiv", "arxiv")]
        )
        self.assertEqual([k["url"] for k in keep], ["arxiv"])

    def test_platform_specific_changelog_entries_are_kept(self):
        # 実データ: OS別の別記事が0.94になった。閾値0.95で別記事として残す
        base = "Cloudflare One Client - Cloudflare One Client for {} (version 2026.9.1)"
        items = [art(base.format(os_name), os_name, "cloudflare_changelog")
                 for os_name in ("macOS", "Windows", "Linux")]
        keep, merged = semantic_dedup.group_near_duplicates(items)
        self.assertEqual(len(keep), 3)

    def test_recent_added_articles_are_compared_but_failed_ones_are_not(self):
        t = "Procedural content generation in practice and its limits"
        new = [art(t, "new")]
        keep, merged = semantic_dedup.group_near_duplicates(
            new, recent=[{"title": t, "url": "old", "status": "added"}])
        self.assertEqual((len(keep), len(merged)), (0, 1))
        # 追加に失敗した記事に統合してしまうと内容が失われるため、比較対象にしない
        keep, merged = semantic_dedup.group_near_duplicates(
            new, recent=[{"title": t, "url": "old", "status": "failed"}])
        self.assertEqual((len(keep), len(merged)), (1, 0))

    def test_short_titles_need_exact_match(self):
        keep, merged = semantic_dedup.group_near_duplicates([art("Unity入門", "a"), art("Unity応用", "b")])
        self.assertEqual(len(keep), 2)


class ClassifierTest(unittest.TestCase):
    def test_off_topic_abstains(self):
        for title in ["今日の夕飯はカレーにした", "My trip to Kyoto in autumn", "Capital markets weekly outlook"]:
            self.assertEqual(classify(title)["label"], NONE_LABEL, title)

    def test_basic_labels(self):
        self.assertEqual(classify("HLSLでレイトレーシングを実装する")["label"], "graphics_research")
        self.assertEqual(classify("RAGとMCPでドキュメントを検索する")["label"], "software_engineering")
        self.assertEqual(classify("Unityでゲームを作る")["label"], "game_dev_tech")

    def test_tie_lowers_confidence(self):
        # 「Unity」(ゲーム開発)と「シェーダ」(グラフィクス)が同点。決めきれないので確信度を下げて返す
        r = classify("Unityのシェーダ入門")
        self.assertIn(r["label"], ("game_dev_tech", "graphics_research"))
        self.assertLessEqual(r["confidence"], 0.5)

    def test_glued_session_code_still_matches(self):
        # CEDiLのタイトルは「2026ENGVAUnreal Engine」のように英字が連結される
        self.assertEqual(classify("CEDEC 2026ENGVAUnreal Engine 5.8 最新アップデート")["label"], "game_dev_tech")

    def test_short_keywords_do_not_false_match(self):
        self.assertEqual(classify("Capital markets")["label"], NONE_LABEL)  # "api" が "capital" に当たらない

    def test_source_prior_only_for_topical_sources(self):
        self.assertNotEqual(classify("キャラクターの当たり判定", source_type="unity")["label"], NONE_LABEL)
        self.assertEqual(classify("人間らしい文章", source_type="x_post")["label"], NONE_LABEL)


class CollectorHelpersTest(unittest.TestCase):
    def test_sidefx_fix_noise(self):
        self.assertTrue(rn.is_sidefx_fix_noise("21.0.863: Fixed broken syntax for the Mater..."))
        self.assertTrue(rn.is_sidefx_fix_noise("22.0.1: Fixing crash when switching"))
        self.assertFalse(rn.is_sidefx_fix_noise("22.0.467: The VDB Leaf Point COP supports I..."))

    def test_latest_sidefx_series_is_numeric_not_lexical(self):
        page = "/changelog/rss/9_5/ /changelog/rss/21_0/ /changelog/rss/22_0/"
        self.assertEqual(rn.latest_sidefx_series(page), "22_0")
        self.assertIsNone(rn.latest_sidefx_series("no feeds here"))

    def test_parse_x_urls(self):
        text = """# comment
https://x.com/abc_def/status/123   # trailing comment
https://twitter.com/abc_def/status/456
https://x.com/abc_def/status/123
https://example.com/not/x
not a url
"""
        self.assertEqual(xc.parse_x_urls(text), [("abc_def", "123"), ("abc_def", "456")])

    def test_x_collect_without_file_is_noop(self):
        old = xc.X_URLS_FILE
        xc.X_URLS_FILE = os.path.join(tempfile.gettempdir(), "definitely-not-here-x-urls.txt")
        try:
            self.assertEqual(xc.collect(), [])
        finally:
            xc.X_URLS_FILE = old

    def test_watch_extract_links_keeps_order_and_dedups(self):
        html = '<a href="/a/b/c">1</a><a href="/d/e/f">2</a><a href="/a/b/c">dup</a><a href="/x">no</a>'
        self.assertEqual(wc.extract_links(html, WATCH_RE), ["/a/b/c", "/d/e/f"])


WATCH_RE = wc.WATCHES[0]["link_re"]


class BuildSiteTest(unittest.TestCase):
    def test_external_input_is_escaped(self):
        import build_site as bs
        evil = [{
            "url_hash": "x", "url": "javascript:alert(1)",
            "title": '<script>alert(1)</script><img src=x onerror=alert(2)>',
            "source_type": "unity", "platform": 'zenn"><script>alert(3)</script>',
            "categories": ['game_dev_tech" onmouseover="alert(4)'],
            "keywords": ["<b>kw</b>"], "review": False, "status": "added",
            "published": "2026-10-09", "collected_at": "2026-10-09T01:00:00Z",
        }]
        health = {"daily": {"status": "ok", "run_at": "2026-10-09T01:00:00Z", "failed_sources": 1,
                            "source_failures": [{"source": "<script>x</script>", "error": '"><svg onload=alert(5)>'}]}}
        page = bs.build_results(evil, health, [{"watch": "w", "title": "<i>t</i>", "url": "javascript:evil()",
                                                "detected_at": "2026-10-09T00:00:00Z"}],
                                datetime.now(timezone.utc))
        dynamic = page.split('<ul class="list"', 1)[1].split("<script>\n(function", 1)[0]
        self.assertNotIn("<script", dynamic.lower())
        self.assertNotIn("<img", dynamic.lower())
        self.assertNotIn("<svg", dynamic.lower())
        self.assertNotIn('href="javascript:', page)

    def test_empty_inputs_build(self):
        import build_site as bs
        page = bs.build_results([], {}, [], datetime.now(timezone.utc))
        self.assertIn("この期間は静かでした", page)
        self.assertIn("まだ記録がありません", page)

    def test_unknown_numbers_are_dashes_not_fake(self):
        import build_site as bs
        self.assertIn("—", bs.stat_cell(None, "冊", "NotebookLM ノートブック"))

    def test_dates_are_iso(self):
        import build_site as bs
        self.assertEqual(bs.display_date({"published": "2026-10-09T00:00:00+00:00"}), "2026-10-09")
        self.assertEqual(bs.display_date({"collected_at": "2026-10-09T16:00:00Z"}), "2026-10-10")  # JST


if __name__ == "__main__":
    unittest.main()
