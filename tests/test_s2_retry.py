"""Semantic Scholar のレート制限(HTTP 429)への対応のテスト。ネットワークは使わない。"""
import io
import json
import os
import sys
import unittest
import urllib.error
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from collectors import _academic_api as api  # noqa: E402
from collectors import paper_collector as pc  # noqa: E402
from collectors.retry import pop_failures  # noqa: E402


def _http_error(code, retry_after=None):
    headers = {"Retry-After": retry_after} if retry_after else {}
    return urllib.error.HTTPError("https://api.semanticscholar.org/x", code, "err", headers, io.BytesIO(b""))


class _Resp:
    def __init__(self, payload):
        self._b = json.dumps(payload).encode("utf-8")

    def read(self):
        return self._b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class FetchTests(unittest.TestCase):
    def setUp(self):
        api._s2_last_call = 0.0
        self.sleeps = []
        p = mock.patch.object(api.time, "sleep", side_effect=self.sleeps.append)
        p.start()
        self.addCleanup(p.stop)

    def test_retries_429_honoring_retry_after_then_succeeds(self):
        seq = [_http_error(429, "3"), _http_error(429), _Resp({"data": [1]})]
        with mock.patch.object(api.urllib.request, "urlopen", side_effect=seq):
            self.assertEqual(api.fetch_json_s2("https://example.test/x"), {"data": [1]})
        waits = [s for s in self.sleeps if s >= 3]
        self.assertEqual(waits, [3.0, 10.0])  # Retry-After の値 → 無ければ 5 * 2^(attempt-1)

    def test_gives_up_with_rate_limited_after_max_attempts(self):
        calls = []

        def boom(*a, **k):
            calls.append(1)
            raise _http_error(429)

        with mock.patch.object(api.urllib.request, "urlopen", side_effect=boom):
            with self.assertRaises(api.S2RateLimited):
                api.fetch_json_s2("https://example.test/x")
        self.assertEqual(len(calls), api.S2_MAX_ATTEMPTS)
        self.assertTrue(all(s <= api.S2_MAX_DELAY for s in self.sleeps))

    def test_non_retryable_error_is_raised_immediately(self):
        with mock.patch.object(api.urllib.request, "urlopen", side_effect=_http_error(404)) as m:
            with self.assertRaises(urllib.error.HTTPError):
                api.fetch_json_s2("https://example.test/x")
        self.assertEqual(m.call_count, 1)

    def test_api_key_is_sent_when_configured(self):
        seen = {}

        def capture(req, timeout=0):
            seen.update(dict(req.header_items()))
            return _Resp({"data": []})

        with mock.patch.dict(os.environ, {api.S2_API_KEY_ENV: "k-123"}):
            with mock.patch.object(api.urllib.request, "urlopen", side_effect=capture):
                api.fetch_json_s2("https://example.test/x")
        self.assertEqual(seen.get("X-api-key"), "k-123")

    def test_no_key_header_when_not_configured(self):
        seen = {}

        def capture(req, timeout=0):
            seen.update(dict(req.header_items()))
            return _Resp({"data": []})

        env = {k: v for k, v in os.environ.items() if k != api.S2_API_KEY_ENV}
        with mock.patch.dict(os.environ, env, clear=True):
            with mock.patch.object(api.urllib.request, "urlopen", side_effect=capture):
                api.fetch_json_s2("https://example.test/x")
        self.assertNotIn("X-api-key", seen)


class CollectorTests(unittest.TestCase):
    def test_stops_after_consecutive_rate_limit_failures(self):
        pop_failures()
        with mock.patch.object(pc, "_fetch_json", side_effect=api.S2RateLimited("429")) as m, \
                mock.patch.object(pc.time, "sleep"):
            out = pc.collect_semantic_scholar(max_per_query=1)
        self.assertEqual(out, [])
        self.assertEqual(m.call_count, api.S2_GIVE_UP_AFTER)  # 残りのクエリは打ち切る
        failures = pop_failures()
        self.assertEqual(len(failures), api.S2_GIVE_UP_AFTER + 1)  # 失敗した分 + 打ち切りの1件
        self.assertIn("skipped", failures[-1]["error"])

    def test_other_errors_do_not_trigger_the_cutoff(self):
        pop_failures()
        with mock.patch.object(pc, "_fetch_json", side_effect=RuntimeError("boom")) as m, \
                mock.patch.object(pc.time, "sleep"):
            pc.collect_semantic_scholar(max_per_query=1)
        self.assertEqual(m.call_count, len(pc.SEMANTIC_SCHOLAR_QUERIES))
        pop_failures()


if __name__ == "__main__":
    unittest.main()
