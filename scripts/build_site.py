"""
静的サイト生成 — IMPROVEMENT_DESIGN_2026-10.md(U1〜U4)

入力: articles_log.json(収集記事ログ)/ health.json(実行結果)/ watch_state.json(新着監視)
出力:
  - results.html : 収集結果ビュー(U2)。サーバー不要の静的HTML。
  - index.html   : <!--SITE_STATUS_START/END--> と <!--SITE_STATS_START/END--> の間だけ書き換える(U1)。
                   数値は手書きせず、必ずここで生成する。

daily_collect.yml / weekly_digest.yml の中で実行し、結果をコミットする。

【表示の決めごと(U3 / 決めごと表。DOCUMENT.md「UI の決めごと」と同じ)】
  - 色の役割: 紫=主操作・リンク / シアン=収集済み・新着 / 橙=注意(失敗・要確認)。ほかの用途に使わない
  - 数字・日付: 半角・等幅。日付は 2026-10-06 に統一
  - 取得状況は画面上部に固定: 「最終収集 … · 取得 n · 新規 n · 失敗 n件」
  - 記事に埋め込む文字は必ず HTML エスケープする(フィードのタイトルは外部入力)
"""

import html
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone

CODE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, CODE_ROOT)
# データの読み込み先・出力先。通常はリポジトリのルート。SITE_ROOT でテスト用の場所に切り替えられる。
ROOT = os.environ.get("SITE_ROOT") or CODE_ROOT

JST = timezone(timedelta(hours=9))

CATEGORY_LABELS = {
    "game_dev_tech":        "Game-Dev-Tech",
    "graphics_research":    "Graphics-Research",
    "software_engineering": "Software-Engineering",
}

PLATFORM_LABELS = {
    "zenn": "Zenn", "qiita": "Qiita",
    "unity_blog": "Unity Blog", "ue_blog": "UE Blog",
    "cedil": "CEDiL", "cedec_youtube": "CEDEC YouTube",
    "arxiv": "arXiv", "semantic_scholar": "Semantic Scholar",
    "sidefx_changelog": "SideFX", "cloudflare_changelog": "Cloudflare",
    "huggingface_blog": "Hugging Face", "x": "X",
}


# ------------------------------------------------------------------ #
#  入力の読み込み
# ------------------------------------------------------------------ #

def _read_json(name: str, default):
    path = os.path.join(ROOT, name)
    if not os.path.exists(path):
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"[build_site] {name} unreadable ({e}), using default")
        return default


def load_inputs():
    log = _read_json("articles_log.json", {}).get("entries", [])
    health = _read_json("health.json", {})
    watch_state = _read_json("watch_state.json", {})
    watch_recent = sorted(
        [it for e in watch_state.values() for it in e.get("recent", [])],
        key=lambda i: i.get("detected_at", ""), reverse=True,
    )[:10]
    return log, health, watch_recent


# ------------------------------------------------------------------ #
#  表示用の整形
# ------------------------------------------------------------------ #

def esc(text) -> str:
    return html.escape(str(text if text is not None else ""), quote=True)


def safe_href(url: str) -> str:
    """http(s) 以外のURL(javascript: 等)は無効なリンクにする。"""
    return esc(url) if re.match(r"^https?://", url or "", re.IGNORECASE) else "#"


def to_jst(iso_z: str):
    try:
        return datetime.strptime(iso_z, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).astimezone(JST)
    except Exception:
        return None


def display_date(entry: dict) -> str:
    """一覧の日付: 公開日があればそれ、無ければ収集日(JST)。"""
    if entry.get("published"):
        return entry["published"][:10]
    dt = to_jst(entry.get("collected_at", ""))
    return dt.strftime("%Y-%m-%d") if dt else "0000-00-00"


def status_info(health: dict) -> dict:
    daily = health.get("daily", {}) if isinstance(health, dict) else {}
    dt = to_jst(daily.get("run_at", ""))
    return {
        "last":      dt.strftime("%Y-%m-%d %H:%M") if dt else None,
        "ok":        daily.get("status") == "ok",
        "collected": daily.get("collected"),
        "new":       daily.get("new"),
        "failed":    daily.get("failed_sources", 0) or 0,
        "failures":  daily.get("source_failures", []) or [],
        "notebooks": daily.get("notebooks_total"),
        "error":     daily.get("error"),
    }


def status_line_html(st: dict) -> str:
    """画面上部に固定する取得状況(P9)。failed があれば橙で目立たせる。"""
    if not st["last"]:
        return '<span class="status-line">取得状況: まだ記録がありません</span>'
    parts = [f'最終収集 <b>{esc(st["last"])}</b> JST']
    if st["collected"] is not None:
        parts.append(f'取得 <b>{esc(st["collected"])}</b>')
    if st["new"] is not None:
        parts.append(f'新規 <b class="ok">{esc(st["new"])}</b>')
    if st["failed"]:
        parts.append(f'<b class="warn">失敗 {esc(st["failed"])}件</b>')
    else:
        parts.append("失敗 <b>0件</b>")
    if not st["ok"]:
        parts.append(f'<b class="warn">直近の実行はエラー: {esc(st["error"] or "unknown")}</b>')
    return '<span class="status-line">' + " · ".join(parts) + "</span>"


def count_sources() -> int:
    """収集元(フィード・API)の数。コードの定義から数える(手書きしない)。"""
    from collectors import (
        zenn_qiita_collector as zq, unity_ue_collector as uu,
        release_notes_collector as rn,
    )
    feeds = len(zq.ALL_FEEDS) + len(uu.ALL_FEEDS)
    feeds += 2   # CEDEC: CEDiL + YouTube
    feeds += 2   # 論文: arXiv + Semantic Scholar
    feeds += len(rn.STATIC_FEEDS) + 1   # 更新情報: 静的フィード + SideFX
    return feeds


def week_start_jst(now: datetime) -> str:
    d = now.astimezone(JST).date()
    return (d - timedelta(days=d.weekday())).strftime("%Y-%m-%d")


def count_this_week(log: list[dict], now: datetime) -> int:
    start = week_start_jst(now)
    n = 0
    for e in log:
        dt = to_jst(e.get("collected_at", ""))
        if dt and dt.strftime("%Y-%m-%d") >= start:
            n += 1
    return n


# ------------------------------------------------------------------ #
#  results.html
# ------------------------------------------------------------------ #

RESULTS_TEMPLATE = r'''<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>収集結果 — Research Collector</title>
<script>try{var t=localStorage.getItem("rc-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Noto+Sans+JP:wght@300;400;700&family=DM+Serif+Display&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #f5f2ea; --surface: #fbf9f3; --surface2: #ece8dd; --border: #d9d3c3;
    --accent: #5b49d6; --accent2: #0e7c74; --accent3: #b45309;
    --text: #1c1a16; --text-muted: #666050; --text-dim: #a8a190;
    --mono: 'Space Mono', monospace; --sans: 'Noto Sans JP', sans-serif; --serif: 'DM Serif Display', serif;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #0a0a0f; --surface: #111118; --surface2: #1a1a24; --border: #2a2a3a;
      --accent: #7c6ef5; --accent2: #4fd1c5; --accent3: #f6ad55;
      --text: #e8e8f0; --text-muted: #8a8ab8; --text-dim: #404060;
    }
  }
  :root[data-theme="dark"] {
    --bg: #0a0a0f; --surface: #111118; --surface2: #1a1a24; --border: #2a2a3a;
    --accent: #7c6ef5; --accent2: #4fd1c5; --accent3: #f6ad55;
    --text: #e8e8f0; --text-muted: #8a8ab8; --text-dim: #404060;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: var(--bg); color: var(--text); font-family: var(--sans); font-weight: 300; line-height: 1.7; }
  a { color: inherit; }
  .num, time, .status-line b { font-family: var(--mono); font-variant-numeric: tabular-nums; }

  .top { position: sticky; top: 0; z-index: 10; background: var(--bg); border-bottom: 1px solid var(--border); }
  .top-inner { max-width: 880px; margin: 0 auto; padding: .75rem 1.5rem; display: flex; flex-wrap: wrap; gap: .4rem 1.5rem; align-items: center; justify-content: space-between; }
  .brand { font-family: var(--mono); font-size: .72rem; letter-spacing: .15em; text-transform: uppercase; color: var(--accent); text-decoration: none; }
  .status-line { font-size: .75rem; color: var(--text-muted); }
  .status-line b { font-weight: 700; color: var(--text); white-space: nowrap; }
  .status-line b.ok { color: var(--accent2); }
  .status-line b.warn { color: var(--accent3); }
  .theme-btn { font-family: var(--mono); font-size: .68rem; letter-spacing: .08em; background: none; color: var(--text-muted); border: 1px solid var(--border); border-radius: 999px; padding: .25rem .8rem; cursor: pointer; }
  .theme-btn:hover { border-color: var(--accent); color: var(--accent); }

  main { max-width: 880px; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; }
  h1 { font-family: var(--serif); font-weight: 400; font-size: clamp(2rem, 5vw, 3rem); line-height: 1.15; }
  .subtitle { color: var(--text-muted); font-size: .9rem; margin: .3rem 0 2rem; }

  .controls { display: flex; flex-direction: column; gap: .9rem; margin-bottom: 1.25rem; }
  .row-controls { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
  .tabs { display: inline-flex; gap: .25rem; background: var(--surface); border: 1px solid var(--border); border-radius: 999px; padding: .2rem; }
  .tab, .chip, .sort-btn { font-family: var(--sans); font-size: .8rem; cursor: pointer; border: 1px solid transparent; background: none; color: var(--text-muted); border-radius: 999px; padding: .25rem .9rem; }
  .tab[aria-pressed="true"] { background: var(--accent); color: #fff; }
  .chip { border-color: var(--border); }
  .chip:hover, .tab:hover:not([aria-pressed="true"]), .sort-btn:hover { color: var(--text); border-color: var(--accent); }
  .chip[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); background: var(--surface); }
  .chip.review { color: var(--accent3); border-color: var(--accent3); }
  .chip.review[aria-pressed="true"] { background: var(--surface); }
  .chip .n { font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: .7rem; margin-left: .35rem; opacity: .8; }
  .sort-btn { margin-left: auto; border-color: var(--border); }
  .range-note { font-family: var(--mono); font-size: .7rem; color: var(--text-muted); }
  button:focus-visible, a:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .list { list-style: none; border-top: 1px solid var(--border); }
  .row { display: grid; grid-template-columns: 1rem minmax(0, 1fr) auto; gap: .9rem; padding: .85rem 0; border-bottom: 1px solid var(--border); align-items: start; }
  .row[hidden] { display: none; }
  .mark { width: .6rem; height: .6rem; border-radius: 50%; margin-top: .55rem; border: 2px solid var(--accent2); background: var(--accent2); }
  .row[data-status="failed"] .mark { background: transparent; border-color: var(--accent3); }
  .row[data-status="merged"] .mark { background: transparent; border-color: var(--text-dim); }
  .row[data-status="merged"] .title { color: var(--text-muted); }
  .title { font-weight: 400; font-size: .95rem; line-height: 1.5; text-decoration: none; overflow-wrap: anywhere;
           display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .title:hover { color: var(--accent); text-decoration: underline; }
  .sub { font-size: .76rem; color: var(--text-muted); margin-top: .1rem; }
  .sub .flag { color: var(--accent3); font-weight: 400; }
  .row time { font-size: .75rem; color: var(--text-muted); white-space: nowrap; padding-top: .2rem; }

  .empty { text-align: center; color: var(--text-muted); padding: 3.5rem 0; font-size: .9rem; }
  .empty b { display: block; font-family: var(--serif); font-weight: 400; font-size: 1.4rem; color: var(--text); margin-bottom: .3rem; }

  details { margin-top: 2rem; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
  summary { cursor: pointer; padding: .7rem 1rem; font-size: .8rem; color: var(--text-muted); }
  details[open] summary { border-bottom: 1px solid var(--border); }
  details ul { list-style: none; padding: .5rem 1rem .8rem; font-size: .8rem; }
  details li { padding: .3rem 0; border-bottom: 1px solid var(--border); overflow-wrap: anywhere; }
  details li:last-child { border-bottom: none; }
  details .meta { font-family: var(--mono); font-size: .7rem; color: var(--text-muted); }
  details .warn { color: var(--accent3); }

  .notes { margin-top: 2.5rem; font-size: .75rem; color: var(--text-muted); border-top: 1px solid var(--border); padding-top: 1rem; }
  .notes p + p { margin-top: .3rem; }

  @media (max-width: 600px) {
    .row { grid-template-columns: 1rem minmax(0, 1fr); }
    .row time { grid-column: 2; padding-top: 0; }
    .sort-btn { margin-left: 0; }
  }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; scroll-behavior: auto !important; } }
</style>
</head>
<body>
<header class="top">
  <div class="top-inner">
    <a class="brand" href="index.html">Research Collector</a>
    {{STATUS_LINE}}
    <button class="theme-btn" id="theme-btn" type="button" aria-label="テーマを切り替える">テーマ</button>
  </div>
</header>

<main>
  <h1>収集結果</h1>
  <p class="subtitle">毎日集まった記事の一覧 — 収集元・ノートブック・キーワード付き</p>

  <div class="controls">
    <div class="row-controls">
      <div class="tabs" role="group" aria-label="期間">
        <button class="tab" type="button" data-range="week" aria-pressed="true">今週</button>
        <button class="tab" type="button" data-range="lastmonth" aria-pressed="false">先月</button>
        <button class="tab" type="button" data-range="all" aria-pressed="false">すべて</button>
      </div>
      <span class="range-note" id="range-note"></span>
      <button class="sort-btn" id="sort-btn" type="button">新しい順</button>
    </div>
    <div class="row-controls" role="group" aria-label="カテゴリ">
      <button class="chip" type="button" data-cat="game_dev_tech" aria-pressed="false">Game-Dev-Tech<span class="n">0</span></button>
      <button class="chip" type="button" data-cat="graphics_research" aria-pressed="false">Graphics-Research<span class="n">0</span></button>
      <button class="chip" type="button" data-cat="software_engineering" aria-pressed="false">Software-Engineering<span class="n">0</span></button>
      <button class="chip review" type="button" data-cat="__review" aria-pressed="false" title="どのカテゴリにも当てはまらない記事。人の確認が必要です">未分類(要確認)<span class="n">0</span></button>
    </div>
  </div>

  <ul class="list" id="list">
{{ROWS}}
  </ul>
  <div class="empty" id="empty" hidden><b>この期間は静かでした。</b>収集した記事はありません。期間やカテゴリを変えてみてください。</div>
{{FAILURES}}
{{WATCH}}
  <div class="notes">
    <p>カテゴリは記事のタイトル等から自動で付けたヒントで、確定ではありません。「未分類」は人の確認を促すための表示です(ノートブックへの振り分けは収集元ごとに決まっており、この分類では変わりません)。</p>
    <p>NotebookLM への追加は非公式APIを利用しています。灰色の丸は、似たタイトルの記事に統合して追加しなかったものです。生成: {{GENERATED}} JST</p>
  </div>
</main>

<script>
(function () {
  var list = document.getElementById("list");
  var rows = Array.prototype.slice.call(list.querySelectorAll(".row"));
  var state = { range: "week", cat: "", desc: true };
  var jst = new Date(Date.now() + 9 * 3600 * 1000);          // JST の暦日を UTC フィールドで読む
  function iso(d) { return d.toISOString().slice(0, 10); }
  function shift(d, days) { return new Date(d.getTime() + days * 86400000); }
  var today = iso(jst);
  var dow = (jst.getUTCDay() + 6) % 7;                        // 月曜=0
  var y = jst.getUTCFullYear(), m = jst.getUTCMonth();
  var ranges = {
    week:      [iso(shift(jst, -dow)), today],
    lastmonth: [iso(new Date(Date.UTC(y, m - 1, 1))), iso(new Date(Date.UTC(y, m, 0)))],
    all:       ["0000-00-00", "9999-99-99"]
  };
  function inRange(r) { var d = r.getAttribute("data-date"); return d >= ranges[state.range][0] && d <= ranges[state.range][1]; }
  function matchCat(r) {
    if (!state.cat) return true;
    if (state.cat === "__review") return r.getAttribute("data-review") === "1";
    return (" " + r.getAttribute("data-cats") + " ").indexOf(" " + state.cat + " ") >= 0;
  }
  function apply() {
    var shown = 0, counts = { game_dev_tech: 0, graphics_research: 0, software_engineering: 0, __review: 0 };
    rows.forEach(function (r) {
      var ir = inRange(r);
      if (ir) {
        (r.getAttribute("data-cats") || "").split(" ").forEach(function (c) { if (c in counts) counts[c]++; });
        if (r.getAttribute("data-review") === "1") counts.__review++;
      }
      var vis = ir && matchCat(r);
      r.hidden = !vis;
      if (vis) shown++;
    });
    Array.prototype.forEach.call(document.querySelectorAll(".chip"), function (c) {
      c.querySelector(".n").textContent = counts[c.getAttribute("data-cat")];
      c.setAttribute("aria-pressed", state.cat === c.getAttribute("data-cat") ? "true" : "false");
    });
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) {
      t.setAttribute("aria-pressed", state.range === t.getAttribute("data-range") ? "true" : "false");
    });
    var r = ranges[state.range];
    document.getElementById("range-note").textContent = state.range === "all" ? "全期間" : r[0] + " 〜 " + r[1];
    document.getElementById("empty").hidden = shown > 0;
  }
  function sortRows() {
    var ordered = rows.slice().sort(function (a, b) {
      var da = a.getAttribute("data-date"), db = b.getAttribute("data-date");
      return da === db ? 0 : (da < db ? 1 : -1) * (state.desc ? 1 : -1);
    });
    ordered.forEach(function (r) { list.appendChild(r); });
    document.getElementById("sort-btn").textContent = state.desc ? "新しい順" : "古い順";
  }
  Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) {
    t.addEventListener("click", function () { state.range = t.getAttribute("data-range"); apply(); });
  });
  Array.prototype.forEach.call(document.querySelectorAll(".chip"), function (c) {
    c.addEventListener("click", function () {
      var v = c.getAttribute("data-cat");
      state.cat = state.cat === v ? "" : v; apply();
    });
  });
  document.getElementById("sort-btn").addEventListener("click", function () { state.desc = !state.desc; sortRows(); });
  document.getElementById("theme-btn").addEventListener("click", function () {
    var root = document.documentElement, cur = root.getAttribute("data-theme");
    if (!cur) cur = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    var next = cur === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("rc-theme", next); } catch (e) {}
  });
  sortRows(); apply();
})();
</script>
</body>
</html>
'''


def render_row(e: dict) -> str:
    cats = e.get("categories", []) or []
    plat = PLATFORM_LABELS.get(e.get("platform", ""), e.get("platform", "") or e.get("source_type", ""))
    nb = " / ".join(CATEGORY_LABELS.get(c, c) for c in cats)
    sub = [esc(plat)]
    if nb:
        sub.append(esc(nb))
    kws = e.get("keywords") or []
    kws = [k for k in kws if not str(k).startswith("source:")]
    if kws:
        sub.append("キーワード: " + esc(", ".join(kws[:3])))
    review = bool(e.get("review"))
    if review:
        sub.append('<span class="flag">要確認(未分類)</span>')
    status = e.get("status", "added")
    if status == "merged":
        sub.append("類似記事に統合")
    elif status == "failed":
        sub.append('<span class="flag">NotebookLMへの追加に失敗</span>')
    date = display_date(e)
    mark_title = {"added": "NotebookLMへ追加済み", "failed": "追加に失敗", "merged": "類似記事に統合"}.get(status, "")
    return (
        f'    <li class="row" data-date="{esc(date)}" data-cats="{esc(" ".join(cats))}" '
        f'data-review="{1 if review else 0}" data-status="{esc(status)}">'
        f'<span class="mark" title="{esc(mark_title)}" role="img" aria-label="{esc(mark_title)}"></span>'
        f'<div><a class="title" href="{safe_href(e.get("url", ""))}" title="{esc(e.get("title", ""))}" target="_blank" rel="noopener noreferrer">{esc(e.get("title") or e.get("url", ""))}</a>'
        f'<div class="sub">{" · ".join(sub)}</div></div>'
        f'<time datetime="{esc(date)}">{esc(date)}</time></li>'
    )


def render_failures(st: dict) -> str:
    if not st["failures"]:
        return ""
    items = "".join(
        f'<li><span class="warn">{esc(f.get("source", ""))}</span><br><span class="meta">{esc(f.get("error", ""))}</span></li>'
        for f in st["failures"]
    )
    return (
        f'  <details><summary>取得に失敗した収集元 <b class="num" style="color:var(--accent3)">{len(st["failures"])}</b> 件(直近の実行)</summary>'
        f"<ul>{items}</ul></details>"
    )


def render_watch(watch_recent: list[dict]) -> str:
    if not watch_recent:
        return ""
    items = "".join(
        f'<li><a href="{safe_href(w.get("url", ""))}" target="_blank" rel="noopener noreferrer">{esc(w.get("title", ""))}</a>'
        f' <span class="meta">{esc(w.get("watch", ""))} · {esc((w.get("detected_at") or "")[:10])}</span></li>'
        for w in watch_recent
    )
    return (
        '  <details><summary>配布サイトの新着(通知のみ・導入はしていません)</summary>'
        f'<ul>{items}</ul>'
        '<p class="meta" style="padding:0 1rem .8rem">導入する前に、中身(SKILL.md など)を人が確認してください。</p></details>'
    )


def build_results(log, health, watch_recent, now: datetime) -> str:
    st = status_info(health)
    ordered = sorted(log, key=lambda e: (display_date(e), e.get("collected_at", "")), reverse=True)
    rows = "\n".join(render_row(e) for e in ordered)
    page = RESULTS_TEMPLATE
    for token, value in {
        "{{STATUS_LINE}}": status_line_html(st),
        "{{ROWS}}": rows,
        "{{FAILURES}}": render_failures(st),
        "{{WATCH}}": render_watch(watch_recent),
        "{{GENERATED}}": now.astimezone(JST).strftime("%Y-%m-%d %H:%M"),
    }.items():
        page = page.replace(token, value)
    return page


# ------------------------------------------------------------------ #
#  index.html の数値(U1)
# ------------------------------------------------------------------ #

def _replace_between(text: str, start: str, end: str, inner: str) -> tuple[str, bool]:
    pattern = re.compile(re.escape(start) + r".*?" + re.escape(end), re.DOTALL)
    if not pattern.search(text):
        return text, False
    return pattern.sub(lambda _m: f"{start}{inner}{end}", text), True


def stat_cell(value, unit: str, label: str) -> str:
    v = "—" if value is None else esc(value)
    return (
        f'<div class="hero-stat"><span class="hero-stat-num">{v}<small>{esc(unit)}</small></span>'
        f'<span class="hero-stat-label">{esc(label)}</span></div>'
    )


def update_index(log, health, now: datetime) -> bool:
    path = os.path.join(ROOT, "index.html")
    if not os.path.exists(path):
        print("[build_site] index.html not found, skipping")
        return False
    with open(path, "r", encoding="utf-8") as f:
        page = f.read()

    st = status_info(health)
    stats = (
        stat_cell(count_sources(), "件", "収集元(フィード・API)")
        + stat_cell(count_this_week(log, now) if log else None, "件", "今週の収集数")
        + stat_cell(st["notebooks"], "冊", "NotebookLM ノートブック")
    )
    page, ok1 = _replace_between(page, "<!--SITE_STATUS_START-->", "<!--SITE_STATUS_END-->", status_line_html(st))
    page, ok2 = _replace_between(page, "<!--SITE_STATS_START-->", "<!--SITE_STATS_END-->", stats)
    if not (ok1 and ok2):
        print("[build_site] index.html markers not found, skipping")
        return False
    with open(path, "w", encoding="utf-8") as f:
        f.write(page)
    return True


def main():
    now = datetime.now(timezone.utc)
    log, health, watch_recent = load_inputs()

    with open(os.path.join(ROOT, "results.html"), "w", encoding="utf-8") as f:
        f.write(build_results(log, health, watch_recent, now))
    print(f"[build_site] results.html: {len(log)} entries")

    if update_index(log, health, now):
        print("[build_site] index.html numbers updated")


if __name__ == "__main__":
    main()
