"""週次ダイジェストのレポート化と、ウォッチ・収集元別件数の送信(ResearchBroadcast Phase 2 追補)のテスト"""
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from nbklm import digest  # noqa: E402
import post_ingest  # noqa: E402
import post_report  # noqa: E402


def _parts():
    return {
        "year": "2026", "week": "W41", "date": "2026-10-11",
        "generated_label": "2026年10月11日 21:08", "generated_at": "2026-10-11T21:08:01Z",
        "notebooks": ["Game-Dev-Tech-2026-W41", "Software-Engineering-2026-W41"],
        "sections": [
            {"category": "game_dev_tech", "label": digest.CATEGORY_LABELS["game_dev_tech"],
             "body": "## 要点\n- **Unity** の更新\n\n## 注目\n本文"},
            {"category": "software_engineering", "label": digest.CATEGORY_LABELS["software_engineering"],
             "body": "> ⚠️ Software-Engineering-2026-W41 のレポート生成に失敗しました\n"},
        ],
    }


class RenderTests(unittest.TestCase):
    def test_render_matches_legacy_format(self):
        md = digest.render_digest_markdown(_parts())
        lines = md.split("\n")
        self.assertEqual(lines[0], "# 週次リサーチダイジェスト — 2026-W41（2026-10-11）")
        self.assertIn("> **収集ノートブック:** Game-Dev-Tech-2026-W41、Software-Engineering-2026-W41", md)
        self.assertIn("> **生成日時:** 2026年10月11日 21:08", md)
        self.assertIn("\n## 🎮 ゲーム開発・エンジン技術\n", md)

    def test_roundtrip_through_markdown(self):
        parts = _parts()
        md = "# Weekly Research Digest — 2026-10-11\n\n" + digest.render_digest_markdown(parts)
        back = digest.parse_digest_markdown(md, "2026-10-11")
        self.assertEqual(back["year"], "2026")
        self.assertEqual(back["week"], "W41")
        self.assertEqual(back["notebooks"], parts["notebooks"])
        self.assertEqual([s["category"] for s in back["sections"]], ["game_dev_tech", "software_engineering"])
        # 本文中の `##` 見出しで分割されない(カテゴリの見出し行だけで分割する)
        self.assertIn("## 注目", back["sections"][0]["body"])

    def test_parse_returns_none_without_sections(self):
        self.assertIsNone(digest.parse_digest_markdown("# 何もない\n本文だけ", "2026-10-11"))


class ReportTests(unittest.TestCase):
    def test_report_shape_and_headings(self):
        r = digest.parts_to_report(_parts())
        self.assertEqual(r["id"], "digest:2026-10-11")
        self.assertEqual(r["kind"], "digest")
        self.assertEqual(r["week"], "2026-W41")
        self.assertEqual(r["generated_at"], "2026-10-11T21:08:01Z")
        self.assertEqual(r["sections"][0]["heading"], "ゲーム開発・エンジン技術")
        self.assertNotIn("ok", r["sections"][0])

    def test_only_failure_sections_means_no_report(self):
        parts = _parts()
        parts["sections"] = [parts["sections"][1]]
        self.assertIsNone(digest.parts_to_report(parts))

    def test_categories_outside_allowlist_never_enter(self):
        parts = _parts()
        parts["sections"].append({"category": "unknown_category", "label": "## unknown_category", "body": "x" * 50})
        r = digest.parts_to_report(parts)
        self.assertEqual({s["category"] for s in r["sections"]}, {"game_dev_tech", "software_engineering"})
        self.assertNotIn("unknown_category", json.dumps(r, ensure_ascii=False))

    def test_unknown_heading_in_markdown_does_not_become_a_section(self):
        md = (
            "# 週次リサーチダイジェスト — 2026-W41（2026-10-11）\n\n"
            + digest.CATEGORY_LABELS["game_dev_tech"] + "\n\n本文A\n\n## 📚 未知の見出し\n\n本文B\n"
        )
        parts = digest.parse_digest_markdown(md, "2026-10-11")
        self.assertEqual(len(parts["sections"]), 1)  # 見出しの一致で分割するので、未知の見出しは前のセクションの本文になる
        r = digest.parts_to_report(parts)
        self.assertEqual([s["category"] for s in r["sections"]], ["game_dev_tech"])

    def test_section_length_is_capped(self):
        parts = _parts()
        parts["sections"][0]["body"] = "あ" * (digest.SECTION_MAX + 500)
        r = digest.parts_to_report(parts)
        self.assertEqual(len(r["sections"][0]["markdown"]), digest.SECTION_MAX)


class PostReportTests(unittest.TestCase):
    def test_load_prefers_structured_json_and_falls_back_to_markdown(self):
        with tempfile.TemporaryDirectory() as d:
            md_path = os.path.join(d, "weekly_digest_2026-10-11.md")
            md = "# Weekly Research Digest — 2026-10-11\n\n" + digest.render_digest_markdown(_parts())
            with open(md_path, "w", encoding="utf-8") as f:
                f.write(md)
            r = post_report.load_report(md_path)  # .json が無い → Markdown から
            self.assertEqual(r["id"], "digest:2026-10-11")
            # 内容のあるセクションが1つでもあれば送る。失敗の注記のセクションも、失敗が見えるよう残す
            self.assertEqual([s["category"] for s in r["sections"]], ["game_dev_tech", "software_engineering"])

            parts = _parts()
            parts["sections"][0]["body"] = "構造化データの本文"
            with open(os.path.join(d, "weekly_digest_2026-10-11.json"), "w", encoding="utf-8") as f:
                json.dump(parts, f, ensure_ascii=False)
            r2 = post_report.load_report(md_path)  # .json がある → そちらを使う
            self.assertEqual(r2["sections"][0]["markdown"], "構造化データの本文")

    def test_unexpected_file_name_is_skipped(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "notes.md")
            with open(p, "w", encoding="utf-8") as f:
                f.write("x")
            self.assertIsNone(post_report.load_report(p))

    def test_requests_are_split_to_the_receiver_limit(self):
        reps = [{"id": f"digest:2026-10-{i:02d}"} for i in range(1, 13)]
        reqs = post_report.build_requests(reps, datetime(2026, 10, 12, tzinfo=timezone.utc))
        self.assertEqual([len(r["reports"]) for r in reqs], [5, 5, 2])
        self.assertTrue(all(r["schema"] == post_ingest.SCHEMA_VERSION for r in reqs))

    def test_expand_treats_md_and_json_pair_as_one(self):
        with tempfile.TemporaryDirectory() as d:
            for name in ("weekly_digest_2026-10-11.md", "weekly_digest_2026-10-11.json", "weekly_digest_2026-10-04.md"):
                open(os.path.join(d, name), "w").close()
            files = post_report.expand([os.path.join(d, "weekly_digest_*")])
            self.assertEqual(len(files), 2)


class WatchAndSourceTests(unittest.TestCase):
    def test_watch_items_are_filtered_and_capped(self):
        items = [
            {"watch": "skills.sh", "title": "a/b · c", "url": "https://skills.sh/a/b/c", "detected_at": "2026-10-11T21:00:00Z"},
            {"watch": "skills.sh", "title": "x", "url": "javascript:alert(1)", "detected_at": "2026-10-11T21:00:00Z"},
            {"watch": "skills.sh", "title": "", "url": "https://skills.sh/a", "detected_at": "2026-10-11T21:00:00Z"},
            "not a dict",
        ]
        out = post_ingest.build_watch(items)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["url"], "https://skills.sh/a/b/c")
        many = [{"watch": "w", "title": "t", "url": f"https://e.com/{i}", "detected_at": "2026-10-11T21:00:00Z"} for i in range(80)]
        self.assertEqual(len(post_ingest.build_watch(many)), 50)

    def test_by_source_counts(self):
        health = {"daily": {"by_source": {"Zenn/Qiita": 48, "bad": -1, "worse": "x", "ok": 0}}}
        self.assertEqual(post_ingest.build_by_source(health), {"Zenn/Qiita": 48, "ok": 0})
        self.assertEqual(post_ingest.build_by_source({}), {})

    def test_watch_and_by_source_ride_on_the_first_batch(self):
        now = datetime(2026, 10, 12, tzinfo=timezone.utc)
        health = {"daily": {"run_at": "2026-10-11T21:00:00Z", "collected": 10, "by_source": {"Zenn/Qiita": 10}}}
        watch = [{"watch": "skills.sh", "title": "t", "url": "https://skills.sh/a/b/c", "detected_at": "2026-10-11T21:00:00Z"}]
        batches, stats = post_ingest.build_batches([], health, now, watch=watch)
        self.assertEqual(len(batches), 1)  # 記事が無くても、ウォッチだけの送信になる
        self.assertEqual(batches[0]["watch"], watch)
        self.assertEqual(batches[0]["run"]["by_source"], {"Zenn/Qiita": 10})
        self.assertEqual(stats["watch"], 1)


if __name__ == "__main__":
    unittest.main()
