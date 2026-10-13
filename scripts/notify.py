"""
スマホへの通知(ntfy.sh / Slack の Incoming Webhook)— 放送が出たとき・収集が失敗したときに知らせる

任意の工程: 宛先が未設定なら何もしない(既存の収集には影響しない)。送信に失敗しても、収集の結果には影響しない
(ワークフロー側で continue-on-error)。

宛先(どちらか、または両方):
    NTFY_TOPIC            ntfy.sh のトピック名。**推測されにくい名前**にすること(トピック名が合言葉になる)
    NTFY_SERVER           既定 https://ntfy.sh(自前のサーバーを使う場合)
    SLACK_WEBHOOK_URL     Slack の Incoming Webhook URL(https://hooks.slack.com/…)
サイトの URL(通知をタップしたときに開く先):
    BROADCAST_SITE_URL    未設定なら BROADCAST_INGEST_URL から、末尾の /api/ingest を除いて作る

使い方:
    python scripts/notify.py digest  [--window-hours 2]   # 直近の新着の要約(新着が無ければ送らない)
    python scripts/notify.py failure --workflow "Daily Research Collect" --run-url https://…
    python scripts/notify.py report  --title "週次リサーチダイジェスト — 2026-W41"
    --dry-run で、送らずに内容だけ表示する

通知に載せるのは、記事の題名・件数・サイトへのリンクだけ(要約や本文は載せない)。ローカル限定の分野は、
articles_log.json に無いので載らない(念のため、3カテゴリ以外は除く)。
"""

import argparse
import json
import logging
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

logger = logging.getLogger("notify")

TITLE_MAX = 70
TOP_ITEMS = 3


def site_url() -> str:
    explicit = os.environ.get("BROADCAST_SITE_URL", "").strip()
    if explicit:
        return explicit.rstrip("/")
    ingest = os.environ.get("BROADCAST_INGEST_URL", "").strip()
    if ingest.endswith("/api/ingest"):
        return ingest[: -len("/api/ingest")]
    return ""


def _short(text: str, n: int = TITLE_MAX) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= n else text[: n - 1] + "…"


def _parse_iso(value: str):
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except Exception:
        return None


def build_digest_message(entries: list[dict], health: dict, now: datetime,
                         window_hours: float = 2, base_url: str = "") -> dict | None:
    """直近 window_hours 時間に収集した記事から、通知の内容を作る。新着が無ければ None。"""
    from nbklm import episodes as ep  # 遅延import(他の通知で余計な読み込みをしない)

    cutoff = now - timedelta(hours=window_hours)
    fresh = []
    for e in entries:
        ts = _parse_iso(e.get("collected_at", ""))
        if ts is not None and ts >= cutoff and ep._valid(e):
            fresh.append(e)
    uniq = ep._uniq(ep._order(fresh))
    daily = (health or {}).get("daily", {}) or {}
    failed = int(daily.get("failed_sources") or 0)
    if not uniq:
        return None

    counts = ep._counts(fresh)["by_category"]
    breakdown = " / ".join(
        f"{ep.CATEGORY_LABELS[c]} {counts[c]}" for c in ep.CATEGORIES if counts.get(c)
    )
    lines = [f"・{_short(e['title'])}" for e in uniq[:TOP_ITEMS]]
    if len(uniq) > TOP_ITEMS:
        lines.append(f"ほか {len(uniq) - TOP_ITEMS} 件")
    lines.append(breakdown)
    if failed:
        lines.append(f"取得に失敗した収集元: {failed}件")
    return {
        "title": f"新着 {len(uniq)} 件 — Research Broadcast",
        "message": "\n".join(lines),
        "click": base_url or None,
        "priority": 3,
        "tags": ["radio"],
    }


def build_failure_message(workflow: str, run_url: str = "") -> dict:
    return {
        "title": "収集が失敗しました",
        "message": f"{_short(workflow, 60)} が失敗しました。" + ("\n実行ログを確認してください。" if run_url else ""),
        "click": run_url or None,
        "priority": 4,
        "tags": ["warning"],
    }


def build_report_message(title: str, base_url: str = "") -> dict:
    return {
        "title": "週次レポートが出ました",
        "message": _short(title, 80),
        "click": f"{base_url}/reports" if base_url else None,
        "priority": 3,
        "tags": ["memo"],
    }


def _https(url: str) -> bool:
    u = urlparse(url)
    return u.scheme == "https" and bool(u.hostname)


def _post_json(url: str, payload: dict, timeout: int = 15) -> int:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json; charset=utf-8", "User-Agent": "research-collector/1.0 (notify)"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status


def ntfy_payload(topic: str, msg: dict) -> dict:
    p = {"topic": topic, "title": msg["title"], "message": msg["message"],
         "priority": msg.get("priority", 3), "tags": msg.get("tags", [])}
    if msg.get("click"):
        p["click"] = msg["click"]
    return p


def slack_payload(msg: dict) -> dict:
    text = f"*{msg['title']}*\n{msg['message']}"
    if msg.get("click"):
        text += f"\n<{msg['click']}|開く>"
    return {"text": text}


def send(msg: dict, env=None, dry_run: bool = False) -> list[str]:
    """設定されている宛先へ送る。送った宛先の名前を返す(未設定なら空)。"""
    env = os.environ if env is None else env
    sent = []
    topic = env.get("NTFY_TOPIC", "").strip()
    if topic:
        server = (env.get("NTFY_SERVER", "").strip() or "https://ntfy.sh").rstrip("/")
        if not _https(server):
            logger.error("NTFY_SERVER must be https://")
        elif dry_run:
            logger.info(f"[dry-run] ntfy: {json.dumps(ntfy_payload(topic, msg), ensure_ascii=False)}")
            sent.append("ntfy")
        else:
            try:
                _post_json(server + "/", ntfy_payload(topic, msg))
                sent.append("ntfy")
            except Exception as e:
                logger.error(f"ntfy failed: {e}")
    hook = env.get("SLACK_WEBHOOK_URL", "").strip()
    if hook:
        if not _https(hook):
            logger.error("SLACK_WEBHOOK_URL must be https://")
        elif dry_run:
            logger.info(f"[dry-run] slack: {json.dumps(slack_payload(msg), ensure_ascii=False)}")
            sent.append("slack")
        else:
            try:
                _post_json(hook, slack_payload(msg))
                sent.append("slack")
            except Exception as e:
                logger.error(f"slack failed: {e}")
    return sent


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="放送・失敗・レポートの通知(ntfy / Slack)")
    ap.add_argument("kind", choices=["digest", "failure", "report"])
    ap.add_argument("--window-hours", type=float, default=2)
    ap.add_argument("--workflow", default="収集")
    ap.add_argument("--run-url", default="")
    ap.add_argument("--title", default="週次リサーチダイジェスト")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

    configured = os.environ.get("NTFY_TOPIC", "").strip() or os.environ.get("SLACK_WEBHOOK_URL", "").strip()
    if not configured and not args.dry_run:
        logger.info("NTFY_TOPIC / SLACK_WEBHOOK_URL not set — skipping (optional step)")
        return 0

    base = site_url()
    if args.kind == "failure":
        msg = build_failure_message(args.workflow, args.run_url)
    elif args.kind == "report":
        msg = build_report_message(args.title, base)
    else:
        from nbklm import articles_log
        try:
            with open(os.path.join(ROOT, "health.json"), encoding="utf-8") as f:
                health = json.load(f)
        except Exception:
            health = {}
        msg = build_digest_message(articles_log.load(), health, datetime.now(timezone.utc), args.window_hours, base)
        if msg is None:
            logger.info("no new articles in the window — nothing to notify")
            return 0

    sent = send(msg, dry_run=args.dry_run)
    logger.info(f"notified: {', '.join(sent) if sent else 'nobody'} — {msg['title']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
