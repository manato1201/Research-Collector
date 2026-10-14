"""解説の生成を呼ぶクライアント(scripts/enrich.py)のテスト。ネットワークは使わない。"""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import enrich  # noqa: E402


class UrlTests(unittest.TestCase):
    def test_enrich_url_is_derived_from_the_ingest_url(self):
        self.assertEqual(enrich.enrich_url("https://w.example/api/ingest", 8), "https://w.example/api/enrich?limit=8")
        self.assertEqual(enrich.enrich_url("https://w.example/", 5), "https://w.example/api/enrich?limit=5")


class RunTests(unittest.TestCase):
    def _post(self, responses):
        it = iter(responses)
        calls = []

        def post(url, token):
            calls.append((url, token))
            return next(it)

        return post, calls

    def test_stops_when_nothing_is_pending(self):
        post, calls = self._post([
            {"processed": 8, "ok": 8, "unusable": 0, "errors": 0, "pending": 3},
            {"processed": 3, "ok": 3, "unusable": 0, "errors": 0, "pending": 0},
        ])
        t = enrich.run("https://w/api/ingest", "t", rounds=5, limit=8, post=post)
        self.assertEqual((t["ok"], t["rounds"], t["pending"]), (11, 2, 0))
        self.assertEqual(len(calls), 2)

    def test_stops_after_the_round_limit(self):
        post, calls = self._post([{"processed": 8, "ok": 8, "unusable": 0, "errors": 0, "pending": 99}] * 5)
        t = enrich.run("https://w/api/ingest", "t", rounds=3, limit=8, post=post)
        self.assertEqual(t["rounds"], 3)
        self.assertEqual(t["pending"], 99)

    def test_stops_when_the_model_keeps_failing(self):
        post, calls = self._post([{"processed": 8, "ok": 0, "unusable": 0, "errors": 8, "pending": 50}] * 5)
        t = enrich.run("https://w/api/ingest", "t", rounds=5, limit=8, post=post)
        self.assertEqual(t["rounds"], 1)
        self.assertEqual(t["errors"], 8)

    def test_stops_when_there_is_nothing_to_process(self):
        post, _ = self._post([{"processed": 0, "ok": 0, "unusable": 0, "errors": 0, "pending": 0}])
        t = enrich.run("https://w/api/ingest", "t", rounds=3, limit=8, post=post)
        self.assertEqual(t["rounds"], 1)


class MainTests(unittest.TestCase):
    def test_noop_without_configuration(self):
        env = {k: v for k, v in os.environ.items() if k not in ("BROADCAST_INGEST_URL", "BROADCAST_INGEST_TOKEN")}
        from unittest import mock
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(enrich.main([]), 0)

    def test_refuses_plain_http(self):
        from unittest import mock
        with mock.patch.dict(os.environ, {"BROADCAST_INGEST_URL": "http://evil.example/api/ingest", "BROADCAST_INGEST_TOKEN": "t"}, clear=True):
            self.assertEqual(enrich.main([]), 1)


if __name__ == "__main__":
    unittest.main()
