"""通知(ntfy / Slack)のメッセージ組み立て・宛先の選択・安全側の既定のテスト。ネットワークは使わない。"""
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import notify  # noqa: E402

NOW = datetime(2026, 10, 13, 9, 5, tzinfo=timezone.utc)


def entry(i, hours_ago=0.5, cats=("game_dev_tech",), title=None, platform="zenn"):
    ts = (NOW - timedelta(hours=hours_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "url_hash": f"{i:016x}", "url": f"https://example.com/{i}", "title": title or f"記事{i}",
        "source_type": "unity", "platform": platform, "categories": list(cats), "status": "added",
        "collected_at": ts, "published": "2026-10-13",
    }


class DigestTests(unittest.TestCase):
    def test_none_when_nothing_is_new_in_the_window(self):
        entries = [entry(1, hours_ago=5)]
        self.assertIsNone(notify.build_digest_message(entries, {}, NOW, window_hours=2))

    def test_message_has_count_top_items_breakdown_and_link(self):
        entries = [entry(i) for i in range(1, 6)] + [entry(10, cats=("software_engineering",))]
        m = notify.build_digest_message(entries, {}, NOW, 2, "https://site.example")
        self.assertEqual(m["title"], "新着 6 件 — Research Broadcast")
        self.assertEqual(m["click"], "https://site.example")
        self.assertEqual(m["message"].count("・"), notify.TOP_ITEMS)
        self.assertIn("ほか 3 件", m["message"])
        self.assertIn("Game-Dev-Tech 5", m["message"])
        self.assertIn("Software-Engineering 1", m["message"])

    def test_failed_sources_are_mentioned(self):
        m = notify.build_digest_message([entry(1)], {"daily": {"failed_sources": 2}}, NOW)
        self.assertIn("取得に失敗した収集元: 2件", m["message"])

    def test_categories_outside_the_allowlist_are_never_included(self):
        entries = [entry(1, cats=("unknown_category",)), entry(2)]
        m = notify.build_digest_message(entries, {}, NOW)
        self.assertIn("新着 1 件", m["title"])
        self.assertNotIn("unknown_category", m["message"])

    def test_long_titles_are_shortened(self):
        m = notify.build_digest_message([entry(1, title="あ" * 200)], {}, NOW)
        line = m["message"].splitlines()[0]
        self.assertLessEqual(len(line), notify.TITLE_MAX + 2)
        self.assertTrue(line.endswith("…"))


class OtherMessageTests(unittest.TestCase):
    def test_failure_message_links_to_the_run(self):
        m = notify.build_failure_message("Daily Research Collect", "https://github.com/x/y/actions/runs/1")
        self.assertEqual(m["priority"], 4)
        self.assertEqual(m["click"], "https://github.com/x/y/actions/runs/1")

    def test_report_message_links_to_reports(self):
        m = notify.build_report_message("週次リサーチダイジェスト — 2026-W41", "https://site.example")
        self.assertEqual(m["click"], "https://site.example/reports")


class SendTests(unittest.TestCase):
    MSG = {"title": "t", "message": "m", "click": "https://site.example", "priority": 3, "tags": ["radio"]}

    def test_nothing_is_sent_without_destinations(self):
        with mock.patch.object(notify, "_post_json") as post:
            self.assertEqual(notify.send(self.MSG, env={}), [])
        post.assert_not_called()

    def test_ntfy_payload_shape_and_default_server(self):
        with mock.patch.object(notify, "_post_json") as post:
            sent = notify.send(self.MSG, env={"NTFY_TOPIC": "secret-topic-xyz"})
        self.assertEqual(sent, ["ntfy"])
        url, payload = post.call_args.args
        self.assertEqual(url, "https://ntfy.sh/")
        self.assertEqual(payload["topic"], "secret-topic-xyz")
        self.assertEqual(payload["click"], "https://site.example")

    def test_slack_payload(self):
        with mock.patch.object(notify, "_post_json") as post:
            sent = notify.send(self.MSG, env={"SLACK_WEBHOOK_URL": "https://hooks.slack.com/services/T/B/x"})
        self.assertEqual(sent, ["slack"])
        self.assertIn("*t*", post.call_args.args[1]["text"])

    def test_non_https_destinations_are_refused(self):
        with mock.patch.object(notify, "_post_json") as post:
            sent = notify.send(self.MSG, env={"NTFY_TOPIC": "x", "NTFY_SERVER": "http://insecure.example",
                                              "SLACK_WEBHOOK_URL": "http://hooks.example/x"})
        self.assertEqual(sent, [])
        post.assert_not_called()

    def test_a_failing_destination_does_not_raise(self):
        with mock.patch.object(notify, "_post_json", side_effect=urllib_error()):
            self.assertEqual(notify.send(self.MSG, env={"NTFY_TOPIC": "x"}), [])


def urllib_error():
    import urllib.error
    return urllib.error.URLError("down")


class SiteUrlTests(unittest.TestCase):
    def test_derived_from_ingest_url(self):
        with mock.patch.dict(os.environ, {"BROADCAST_INGEST_URL": "https://w.example/api/ingest"}, clear=True):
            self.assertEqual(notify.site_url(), "https://w.example")

    def test_explicit_wins(self):
        with mock.patch.dict(os.environ, {"BROADCAST_SITE_URL": "https://a.example/", "BROADCAST_INGEST_URL": "https://b/api/ingest"}, clear=True):
            self.assertEqual(notify.site_url(), "https://a.example")


if __name__ == "__main__":
    unittest.main()
