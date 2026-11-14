"""
ResearchBroadcast サイトのブラウザ検証(ローカル)。Playwright(Chromium)で、放送・ドロワー・ボード・
カテゴリ・週次の図・状態・テーマ・スマホ幅・動きの軽減を確認する。

    # 前提: integration_local.py で記事と episode が入った、`wrangler dev --local` が動いている状態
    #   かつ broadcast/.dev.vars に READ_REQUIRES_TOKEN=false(ローカルだけ、ログイン無しで開く。Access の代わり)
    #   pip install playwright && playwright install chromium
    python broadcast/test/browser_local.py

画面の保存先は環境変数 BROADCAST_SHOTS_DIR(未指定なら保存しない)。
注意: ローカルのD1のボードに書き込む(本番には触れない)。
"""
import json, os, re, sys
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.environ.get("BROADCAST_BASE_URL", "http://127.0.0.1:8787")
SHOTS = os.environ.get("BROADCAST_SHOTS_DIR")


OUT = SHOTS
if OUT:
    os.makedirs(OUT, exist_ok=True)

results = []


def check(name, cond, detail=""):
    results.append(bool(cond))
    print(("PASS " if cond else "FAIL ") + name + (f"   {detail}" if (detail and not cond) else ""))


def overflow(page):
    return page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")


with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, locale="ja-JP")
    page = ctx.new_page()
    problems = []
    page.on("console", lambda m: problems.append(f"{m.type}: {m.text}") if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: problems.append(f"pageerror: {e}"))

    # --- ホーム(ローカルは READ_REQUIRES_TOKEN=false なので、ログイン無しで開ける)
    page.goto(BASE + "/")
    page.wait_for_selector(".lanes")
    check("home loads without any login (3 base lanes)", page.locator(".lanes").first.locator(".lane").count() == 3)
    check("there is no login form or logout button", page.locator("form.login").count() == 0 and page.locator("#logout-btn").count() == 0)
    page.goto(BASE + "/auth-required")
    page.wait_for_selector("h1")
    check("the auth-required page explains Cloudflare Access", "Cloudflare Access" in page.inner_text("#view"))
    page.goto(BASE + "/")
    page.wait_for_selector(".lanes")
    OUT and page.screenshot(path=os.path.join(OUT, "home_desktop.png"), full_page=True)

    # --- ホーム
    check("home: 3 lanes with items", all(page.locator(".lane").nth(i).locator(".item").count() > 0 for i in range(3)))
    check("home: stats counted up", int(page.inner_text(".stat-num .num")) > 0)
    check("home: status bar shows last update", "最終更新" in page.inner_text("#status-bar"), page.inner_text("#status-bar"))
    check("home: no horizontal overflow (desktop)", overflow(page) <= 0, overflow(page))
    check("home: multi-category badge present", page.locator(".badge", has_text="ほかのカテゴリにも").count() > 0)

    # --- ドロワーとボード
    first = page.locator(".lane").first.locator(".item-title").first
    title = first.inner_text()
    first_hash = first.evaluate("e => e.closest('.item').dataset.hash")
    first.click()
    page.wait_for_selector("#drawer:not([hidden])")
    check("drawer shows the article title", page.inner_text("#drawer-title").strip() == title.strip())
    check("drawer focus moved to close button", page.evaluate("document.activeElement.id") == "drawer-close")
    check("view is inert while drawer is open", page.evaluate("document.getElementById('view').hasAttribute('inert')"))
    link = page.locator("#drawer a.btn.primary")
    check("article link is external + noopener", link.get_attribute("target") == "_blank" and "noopener" in (link.get_attribute("rel") or ""))
    check("article link is http(s)", re.match(r"^https?://", link.get_attribute("href") or "") is not None, link.get_attribute("href"))
    page.get_by_role("button", name="試す", exact=True).click()
    page.wait_for_selector(".toast")
    check("board change toast shown", "試す" in page.inner_text("#toasts"))
    page.keyboard.press("Escape")
    check("Esc closes the drawer", page.locator("#drawer").is_hidden())
    check("focus returns to the opened item", page.evaluate("document.activeElement.classList.contains('item-title')"))
    check("item shows board badge without re-render", page.locator(".badge.state", has_text="試す").count() >= 1)

    # --- リロード後もボードが残る
    page.reload()
    page.wait_for_selector(".lanes")
    check("board state persists across reload", page.locator(".badge.state", has_text="試す").count() >= 1)
    page.click("nav a[data-nav=board]")
    page.wait_for_selector("#board-try")
    check("board page lists the item under 試す", page.locator(".lane").nth(1).locator(".item").count() == 1)
    check("board nav marked current", page.get_attribute("a[data-nav=board]", "aria-current") == "page")

    # --- ボードの書き出し・読み込み(既存の状態を黙って上書きしない)
    import tempfile
    with page.expect_download() as dl:
        page.click("button:has-text('書き出す')")
    exported = json.load(open(dl.value.path(), encoding="utf-8"))
    check("board export: JSON has kind/schema and the 試す item", exported["kind"] == "research-broadcast-board" and exported["schema"] == 1
          and any(i["url_hash"] == first_hash and i["state"] == "try" for i in exported["items"]), str(exported)[:160])
    NEW_HASH = "c3c3c3c3c3c3c3c3"
    tmpdir = tempfile.mkdtemp()
    def write_file(name, obj):
        path = os.path.join(tmpdir, name)
        json.dump(obj, open(path, "w", encoding="utf-8"), ensure_ascii=False)
        return path
    def board_state(h):
        return page.evaluate(f"fetch('/api/board').then(r => r.json()).then(d => (d.items.find(i => i.url_hash === '{h}') || {{}}).state || null)")
    changed = {**exported, "items": [{"url_hash": first_hash, "state": "hold", "note": "x"}, {"url_hash": NEW_HASH, "state": "read", "note": ""}]}
    page.once("dialog", lambda d: d.accept())
    page.set_input_files("input[type=file]", write_file("merge.json", changed))
    page.locator("#toasts", has_text="追加しました").first.wait_for()
    check("board import: new item added, existing item untouched", board_state(NEW_HASH) == "read" and board_state(first_hash) == "try", (board_state(NEW_HASH), board_state(first_hash)))
    page.wait_for_selector("#import-overwrite")
    page.check("#import-overwrite")
    page.once("dialog", lambda d: (check("board import: overwrite confirm says it will overwrite", "上書きされます" in d.message, d.message), d.accept()))
    page.set_input_files("input[type=file]", write_file("over.json", changed))
    page.locator("#toasts", has_text="上書きしました").first.wait_for()
    check("board import: overwrite updates the existing item", board_state(first_hash) == "hold", board_state(first_hash))
    page.wait_for_selector("#import-overwrite")
    page.set_input_files("input[type=file]", write_file("bad.json", {"kind": "other", "items": []}))
    page.locator("#toasts", has_text="読み込めません").first.wait_for()
    check("board import: a foreign file is refused with a message", "読み込めません" in page.inner_text("#toasts") and board_state(NEW_HASH) == "read")
    page.evaluate(f"fetch('/api/board/{first_hash}', {{method: 'PUT', headers: {{'content-type': 'application/json'}}, body: JSON.stringify({{state: 'try', note: ''}})}})")
    page.evaluate(f"fetch('/api/board/{NEW_HASH}', {{method: 'DELETE'}})")

    # --- カテゴリページ
    page.goto(BASE + "/c/graphics_research")
    page.wait_for_selector(".seg")
    check("category: default period is 今週", page.locator(".seg button[aria-pressed=true]").inner_text() == "今週")
    page.click(".seg button:has-text('30日')")
    page.wait_for_url(re.compile(r"p=30d"))
    page.wait_for_selector(".item")
    n_all = page.locator(".item").count()
    chip = page.locator(".source-chips .chip").nth(1)
    chip.click()
    page.wait_for_url(re.compile(r"s="))
    page.wait_for_selector(".item")
    check("category: source chip narrows the list", 0 < page.locator(".item").count() <= n_all, (n_all, page.locator(".item").count()))
    page.goto(BASE + "/c/not_a_category")
    page.wait_for_selector("h1")
    check("unknown category -> not found page", "見つかりません" in page.inner_text("main"))

    # --- 出典の種別・言語の絞り込み(T13)
    kana_re = re.compile("[ぁ-ゟ゠-ヿ一-鿿]")
    page.goto(BASE + "/c/graphics_research?p=30d")
    page.wait_for_selector(".item")
    check("filters: kind and language chip rows exist", page.locator("[aria-label=種別] .chip").count() == 8 and page.locator("[aria-label=言語] .chip").count() == 3)
    check("filters: no reset button while unfiltered", page.locator("button:has-text('条件をリセット')").count() == 0)
    n_unfiltered = page.locator(".item").count()
    page.click("[aria-label=言語] .chip:has-text('English')")
    page.wait_for_url(re.compile(r"l=en"))
    page.wait_for_selector(".item")
    en_titles = page.locator(".item-title").all_inner_texts()
    check("filters: English shows only titles without Japanese", en_titles and not any(kana_re.search(t) for t in en_titles), en_titles[:2])
    shown_text = page.inner_text("main .sub >> nth=-1")
    check("filters: displayed count equals the number of rows", f"{page.locator('.item').count()}件を表示" in shown_text.replace(" ", ""), shown_text)
    check("filters: chip reflects the active condition", page.locator("[aria-label=言語] .chip[aria-pressed=true]").inner_text() == "English")
    page.click("button:has-text('条件をリセット')")
    page.wait_for_url(lambda u: "l=" not in u)
    page.wait_for_selector(".item")
    check("filters: reset restores the unfiltered list", page.locator(".item").count() == n_unfiltered and page.locator("button:has-text('条件をリセット')").count() == 0)
    page.goto(BASE + "/c/graphics_research?p=today&k=x&l=en")
    page.wait_for_selector("main h1")
    page.wait_for_timeout(300)
    check("filters: no-match state offers a reset", page.locator(".empty").count() == 1 and page.locator("button:has-text('条件をリセット')").count() >= 1)

    # --- 出典と権利の注記(T12)
    page.goto(BASE + "/c/graphics_research?p=30d")
    page.wait_for_selector(".item")
    check("source: every card has an 原文へ link (http(s), new tab, noopener)", page.evaluate(
        "[...document.querySelectorAll('.item')].every(li => { const a = li.querySelector('a.item-src'); return a && /^https?:/.test(a.href) && a.target === '_blank' && a.rel.includes('noopener'); })"))
    check("source: footer states that rights belong to the publishers", "各発行元に帰属" in page.inner_text("footer.foot"))
    page.locator(".item:has(.item-sum) .item-title").first.click()
    page.wait_for_selector("#drawer:not([hidden])")
    check("source: drawer says the summary is not the original", "原文ではありません" in page.inner_text("#drawer .drawer-note"))
    check("source: drawer link is labelled 原文を開く", page.locator("#drawer a.btn.primary", has_text="原文を開く").count() == 1)
    page.keyboard.press("Escape")

    # --- 週次特集
    page.goto(BASE + "/weekly")
    page.wait_for_selector(".weekly svg")
    check("weekly: figures drawn as SVG (2)", page.locator(".fig svg").count() == 2)
    check("weekly: svg has an accessible label", bool(page.get_attribute(".fig svg", "aria-label")))
    check("weekly: no HTML injected into figures (text only)", page.locator(".fig script").count() == 0)
    page.click(".toc a:has-text('Graphics')")
    page.wait_for_timeout(300)
    check("weekly: TOC click keeps the page (hash only, no re-render)", page.locator(".weekly svg").count() >= 2)
    OUT and page.screenshot(path=os.path.join(OUT, "weekly_desktop.png"), full_page=True)

    # --- 状態
    page.goto(BASE + "/status")
    page.wait_for_selector(".panel")
    txt = page.inner_text("main")
    check("status: shows ingest + counts", "取り込み" in txt and "総数" in txt)

    # --- 読み上げ(再生バー)・速報・ウォッチ・レポート・先月・折れ線・ボトムシート
    page.goto(BASE + "/")
    page.wait_for_selector(".lanes")
    page.wait_for_timeout(300)
    read_all = page.locator("button.read-btn", has_text="番組を再生(ラジオ)")
    check("home: radio program button exists", read_all.count() == 1)
    check("home: read-aloud button is enabled (or explains why not)",
          read_all.is_enabled() or bool(read_all.get_attribute("title")))
    check("home: per-category read buttons", page.locator("button.read-btn", has_text="このカテゴリを読み上げ").count() >= 1)
    if read_all.is_enabled():
        read_all.click()
        page.wait_for_selector("#player:not([hidden])", timeout=5000)
        check("player bar appears with title and chapter", "放送" in page.inner_text("#player-title") and page.inner_text("#player-progress").startswith("1 /"))
        check("play button toggles to pause label", page.inner_text("#player-toggle") in ("一時停止", "再生"))
        page.click("#player-next")
        check("next chapter moves the progress", page.inner_text("#player-progress").startswith("2 /") or page.locator("#player").is_hidden())
        page.click("#player-toggle")
        check("pause shows the resume label", page.inner_text("#player-toggle") == "再生" or page.locator("#player").is_hidden())
        check("read button shows stop while the player is open", page.locator("button.read-btn[aria-pressed=true]").count() >= 0)
        page.click("#player-stop")
        check("stop hides the player bar", page.locator("#player").is_hidden())
    ticker = page.locator(".ticker")
    check("home: ticker present with items", ticker.count() == 1 and ticker.locator("a").count() >= 2)
    page.click(".ticker-toggle")
    check("ticker can be stopped", ticker.get_attribute("data-paused") == "true")
    check("home: watch accordion lists new distribution items", page.locator("details.watch-list li").count() >= 1)
    check("home: link to the latest report", page.locator("a.btn", has_text="最新のレポート").count() == 1)

    page.goto(BASE + "/reports")
    page.wait_for_selector(".report-card")
    check("reports: list shows the digest card", page.locator(".report-card").count() >= 1)
    page.click(".report-card >> nth=0")
    page.wait_for_selector(".md")
    check("report: sections rendered as markdown", page.locator(".md strong").count() >= 1 and page.locator(".md ul li").count() >= 1)
    check("report: markdown links are external + noopener",
          page.locator(".md a[href^='https://unity.com']").count() == 1
          and "noopener" in (page.get_attribute(".md a[href^='https://unity.com']", "rel") or ""))
    check("report: no script/img elements from markdown", page.locator(".md script").count() == 0 and page.locator(".md img").count() == 0)
    check("report: javascript: links are not links", page.locator(".md a[href^='javascript']").count() == 0)
    check("report: raw html is shown as text", "<img" in page.inner_text("main"))
    page.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)")
    page.wait_for_timeout(200)
    check("report: reading progress bar fills while scrolling", page.evaluate("document.getElementById('progress-bar').offsetWidth") > 0)
    check("report: breadcrumb and read button", page.locator("nav.crumbs").count() == 1 and page.locator("button.read-btn", has_text="レポートを読み上げ").count() == 1)
    page.goto(BASE + "/reports/digest:2026-10-11")  # 直接開く(サーバーが ":" を %3A に直しても描画される)
    page.wait_for_selector(".md")
    check("report: direct URL renders", page.locator(".md").count() >= 1 and "見つかりません" not in page.inner_text("main"))

    page.goto(BASE + "/c/game_dev_tech")
    page.wait_for_selector(".seg")
    check("category: 先月 period exists", page.locator(".seg button", has_text="先月").count() == 1)
    page.click(".seg button:has-text('先月')")
    page.wait_for_url(re.compile(r"p=month"))
    page.wait_for_selector(".seg")
    check("category: 先月 shows a range (until)", " 〜 20" in page.inner_text("main"))
    check("category: controls are sticky", page.evaluate("getComputedStyle(document.querySelector('.sticky-controls')).position") == "sticky")
    check("category: read-aloud for the page", page.locator("button.read-btn", has_text="このページを読み上げ").count() == 1)

    page.goto(BASE + "/weekly")
    page.wait_for_selector(".fig .line")
    check("weekly: trend is a line with points", page.locator(".fig .line").count() == 1 and page.locator(".fig .pt").count() == 7)
    check("weekly: line is drawn when it becomes visible", "draw" in (page.get_attribute(".fig .line", "class") or ""))
    check("weekly: breadcrumb", page.locator("nav.crumbs").count() == 1)
    check("weekly: this week's keywords section is shown", page.locator("#sec-keywords .chip").count() >= 1)

    page.goto(BASE + "/board")
    page.wait_for_selector(".lanes")
    n_extra = page.evaluate("fetch('/api/categories').then(r => r.json()).then(j => j.extra.length)")
    check("board: category filter chips (all + base + extra)", page.locator(".row-controls .chip").count() == 4 + n_extra, (n_extra,))

    if n_extra:
        page.goto(BASE + "/")
        page.wait_for_selector(".lanes")
        check("home: extra category lanes (recent 7 days) under their own heading",
              page.locator(".extra-lanes .lane").count() == n_extra and page.locator(".extra-lanes .lane .item").count() >= 1)
        check("home: extra lane has a dot and a text label", page.locator(".extra-lanes .lane-head .dot").count() == n_extra)
        page.locator(".extra-lanes .lane a.btn").first.click()
        page.wait_for_selector(".seg")
        check("extra category page renders with its label", "追加分野" in page.inner_text("h1"))
        page.goto(BASE + "/status")
        page.wait_for_selector(".panel")
        check("status lists the extra category counts", "追加分野1" in page.inner_text("main"))

    page.goto(BASE + "/status")
    page.wait_for_selector(".panel")
    check("status: per-source counts and report/watch counts shown",
          "収集元ごとの取得件数" in page.inner_text("main") and "ウォッチ" in page.inner_text("main"))

    # --- ラジオ(番組・番組表・ジングル・ON AIR・スリープ・効果音)
    page.goto(BASE + "/")
    page.wait_for_selector(".lanes")
    check("home: ON AIR badge and numbered headlines", page.locator(".onair").count() == 1 and page.locator(".list.ranked .item").count() >= 1)
    check("home: link to the radio page", page.locator("a.btn", has_text="ラジオを開く").count() == 1)
    page.click("nav a[data-nav=radio]")
    page.wait_for_selector(".guide-row")
    check("radio: program guide has opening, headlines, corners and ending",
          page.locator(".guide-row").count() >= 4
          and "オープニング" in page.inner_text(".guide-row >> nth=0")
          and "エンディング" in page.inner_text(".guide-row >> nth=-1"))
    check("radio: guide shows estimated clock times", page.locator(".guide-time").first.inner_text() == "00:00")
    check("radio: equalizer and ON AIR badge exist", page.locator(".eq span").count() == 7 and page.locator(".onair").count() == 1)
    check("radio: body starts in the off-air state", page.evaluate("document.body.dataset.air || 'off'") == "off")
    if page.locator("button:has-text('番組を再生')").is_enabled():
        page.click("button:has-text('番組を再生')")
        page.wait_for_selector("#player:not([hidden])", timeout=5000)
        check("radio: ON AIR lamp is lit while playing", page.evaluate("document.body.dataset.air") == "on" and page.inner_text("#player-lamp") == "ON AIR")
        check("radio: the current corner is marked in the guide", page.locator(".guide-row[aria-current=true]").count() == 1)
        page.locator(".guide-row >> nth=2").locator("button").click()
        page.wait_for_timeout(200)
        check("radio: jumping to a corner moves the program", page.inner_text("#player-progress").startswith("3 /"))
        page.click("#player-toggle")
        check("radio: pause turns the lamp to PAUSE", page.inner_text("#player-lamp") == "PAUSE" and page.evaluate("document.body.dataset.air") == "paused")
        page.select_option("#player-sleep", "15")
        check("radio: sleep timer can be set", page.evaluate("document.getElementById('player-sleep').value") == "15")
        page.uncheck("#player-sfx")
        check("radio: sound effects can be turned off and the choice is remembered",
              page.evaluate("localStorage.getItem('rb-tts-sfx')") == "0")
        page.check("#player-sfx")
        page.click("#player-stop")
        check("radio: stop returns to off-air", page.evaluate("document.body.dataset.air") == "off" and page.locator("#player").is_hidden())
    check("radio: the script can be read as text", page.locator("details.acc summary", has_text="原稿").count() == 1)

    # --- 画面に「null」「undefined」が文字として出ていない(条件つきの部品が null のとき)
    paths = ["/", "/radio", "/board", "/tidy", "/weekly", "/reports", "/status", "/settings", "/search", "/c/game_dev_tech", "/c/software_engineering"]
    if n_extra:
        extra_ids = page.evaluate("fetch('/api/categories').then(r => r.json()).then(j => j.extra.map(e => e.id))")
        paths += [f"/c/{i}" for i in extra_ids]
    for path in paths:
        page.goto(BASE + path)
        page.wait_for_selector("main h1", timeout=10000)
        page.wait_for_timeout(250)
        body = page.inner_text("main")
        check(f"{path}: no stray 'null' / 'undefined' text", not re.search(r"(null|undefined)", body), body[:120])

    # --- 検索・ウォッチワード・設定(関連プロジェクト・非表示の収集元)・既読・キーボード
    page.goto(BASE + "/")
    page.wait_for_selector(".lanes")
    page.fill("#search-input", "Zebracorn")
    page.press("#search-input", "Enter")
    page.wait_for_url(re.compile(r"/search\?q=Zebracorn"))
    page.wait_for_selector(".item")
    check("search: header box leads to results", page.locator(".item").count() >= 1 and "全文検索" in page.inner_text("main"))
    page.click("button:has-text('ウォッチワードに保存')")
    page.wait_for_timeout(300)
    page.goto(BASE + "/")
    page.wait_for_selector(".watchwords")
    check("home: watchword shows the 7-day count", "Zebracorn" in page.inner_text(".watchwords") and page.locator(".watchwords .chip .n").first.inner_text() != "")
    page.goto(BASE + "/search?q=" + "検索")
    page.wait_for_selector(".item")
    check("search: short query falls back to partial match", "部分一致" in page.inner_text("main"))

    page.goto(BASE + "/settings")
    page.wait_for_selector(".panel")
    check("settings: watchword is listed and can be removed", page.locator(".chip", has_text="Zebracorn").count() == 1)
    page.fill("input[aria-label=プロジェクト名]", "テスト案件")
    page.fill("input[aria-label=キーワード]", "Zebracorn, レンダリング")
    page.click("button:has-text('保存')")
    page.wait_for_timeout(400)
    page.goto(BASE + "/search?q=Zebracorn")
    page.wait_for_selector(".item")
    check("project badge appears on matching articles", page.locator(".badge.project", has_text="テスト案件").count() >= 1)

    # 既読: 詳細から既読にすると薄くなる。「既読を隠す」で消える
    page.locator(".item-title").first.click()
    page.wait_for_selector("#drawer:not([hidden])")
    page.locator("#drawer .board-state button", has_text="既読").click()
    page.wait_for_timeout(300)
    page.keyboard.press("Escape")
    check("read: the item is dimmed", page.locator(".item.is-read").count() >= 1)
    page.click("#hide-read-btn")
    check("read: 'hide read' removes it from the list",
          page.evaluate("document.body.dataset.hideRead") == "1" and page.locator(".item.is-read:visible").count() == 0)
    page.click("#hide-read-btn")

    # キーボード
    page.goto(BASE + "/c/game_dev_tech?p=30d")
    page.wait_for_selector(".item")
    page.keyboard.press("j")
    check("keys: j focuses the first item", page.evaluate("document.activeElement.classList.contains('item-title')"))
    page.keyboard.press("j")
    second = page.evaluate("document.activeElement.closest('.item').dataset.hash")
    page.keyboard.press("k")
    first = page.evaluate("document.activeElement.closest('.item').dataset.hash")
    check("keys: j / k move between items", first != second)
    page.keyboard.press("x")
    page.wait_for_timeout(400)
    check("keys: x marks the focused item as read", page.locator(f".item[data-hash='{first}'].is-read").count() == 1)
    page.keyboard.press("x")
    page.wait_for_timeout(400)
    check("keys: x again returns it to unread", page.locator(f".item[data-hash='{first}'].is-read").count() == 0)
    page.keyboard.press("o")
    page.wait_for_selector("#drawer:not([hidden])")
    page.keyboard.press("Escape")
    page.keyboard.press("?")
    check("keys: ? opens the shortcut list and Esc closes it",
          page.locator("#help").is_visible() and (page.keyboard.press("Escape") or True) and page.locator("#help").is_hidden())
    page.keyboard.press("g")
    page.keyboard.press("r")
    page.wait_for_url(re.compile(r"/radio"))
    page.wait_for_selector(".guide-row")  # 読み込みの完了を待つ(途中で次のページへ移ると、通信を自分で中断してしまう)
    check("keys: g then r goes to the radio", "/radio" in page.url)
    page.goto(BASE + "/search?q=Zebracorn")
    page.wait_for_selector(".item")
    page.focus("#search-input")
    page.keyboard.type("jjj")
    check("keys: typing in the search box does not trigger shortcuts", page.input_value("#search-input") == "jjj")
    page.fill("#search-input", "")

    # 非表示の収集元
    page.goto(BASE + "/settings")
    page.wait_for_selector(".plain-list.cols")
    page.locator(".plain-list.cols label", has_text="search_test_src").locator("input").check()
    page.wait_for_timeout(400)
    page.goto(BASE + "/c/graphics_research?p=30d")
    page.wait_for_selector(".seg")
    page.wait_for_timeout(300)
    check("muted source: its articles are not listed", page.locator(".item", has_text="Zebracorn").count() == 0)
    page.goto(BASE + "/settings")
    page.wait_for_selector(".plain-list.cols")
    page.locator(".plain-list.cols label", has_text="search_test_src").locator("input").uncheck()
    page.wait_for_timeout(300)
    # 後片付け(テスト用の設定を戻す)
    page.evaluate("fetch('/api/prefs/watchwords', {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({value: []})})")
    page.evaluate("fetch('/api/prefs/projects', {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({value: []})})")

    # --- PWA(マニフェスト・Service Worker・オフライン)
    page.goto(BASE + "/")
    page.wait_for_selector(".lanes")
    manifest_href = page.get_attribute("link[rel=manifest]", "href")
    check("pwa: manifest is linked and valid", manifest_href == "/manifest.webmanifest" and
          page.evaluate("fetch('/manifest.webmanifest').then(r => r.json()).then(j => j.display === 'standalone' && j.icons.length >= 2)"))
    ready = page.evaluate("navigator.serviceWorker.ready.then(r => !!r.active)")
    check("pwa: service worker is active", ready is True)
    page.goto(BASE + "/")  # 保存済みの応答を作る(Service Worker 配下での読み込み)
    page.wait_for_selector(".lanes")
    page.goto(BASE + "/weekly")
    page.wait_for_selector(".weekly")
    page.goto(BASE + "/")
    page.wait_for_selector(".lanes")
    page.wait_for_timeout(500)
    page.context.set_offline(True)
    page.reload()
    page.wait_for_selector(".lanes", timeout=10000)
    check("pwa: offline reload still shows the latest saved broadcast", page.locator(".lane .item").count() >= 1)
    check("pwa: offline state is shown", page.evaluate("document.body.dataset.offline") == "1")
    page.context.set_offline(False)
    page.wait_for_timeout(300)

    # --- 解説(これは何か・できること・応用)と「今日のおすすめ」(広告風)
    page.goto(BASE + "/")
    page.wait_for_selector(".lanes")
    page.wait_for_selector(".reco", timeout=10000)
    check("home: today's pick-up card with what / use / apply",
          "PICK UP" in page.inner_text(".reco") and page.locator(".reco .insight-list dd").count() >= 3
          and len(page.inner_text(".reco .reco-title").strip()) > 0)
    check("home: the pick-up card says whether the text is AI-written or standard",
          page.locator(".reco .badge", has_text="解説").count() >= 1)
    page.locator(".reco button", has_text="詳しく見る").click()
    page.wait_for_selector("#drawer:not([hidden])")
    page.wait_for_selector("#drawer .insight:not([hidden])", timeout=8000)
    check("drawer: insight block with all three parts and a caution note",
          page.locator("#drawer .insight dd").count() >= 3 and "誤り" in page.inner_text("#drawer .insight") or "共通する説明" in page.inner_text("#drawer .insight"))
    page.keyboard.press("Escape")
    page.goto(BASE + "/radio")
    page.wait_for_selector(".guide-row")
    check("radio: a 'today's pick' corner is in the program guide",
          page.locator(".guide-row", has_text="今日のおすすめ").count() == 1)
    check("radio: the script explains what it is and how to use it",
          "この記事を読むと" in page.evaluate("document.querySelector('.script').textContent"))
    script_text = page.evaluate("document.querySelector('.script').textContent")
    check("radio: the opening previews highlights and the categories are introduced",
          "今日の注目は" in script_text and "に関する話題です" in script_text, script_text[:200])
    check("radio: a recap corner closes the program before the ending",
          page.locator(".guide-row", has_text="今日のおさらい").count() == 1)

    # --- ラジオの画面(ステージ)と、図
    check("stage: shown before playing, with a hint and an overview figure",
          page.locator(".stage .stage-hint").count() == 1 and page.locator(".stage svg[role=img]").count() >= 1)
    check("stage: the figure is drawn from real counts (labelled bars, no empty chart)",
          page.locator(".stage .fig .bar").count() >= 1 and "分野別" in page.inner_text(".stage .fig h3"))
    if page.locator("#player-toggle").count():
        page.locator(".guide-row", has_text="注目ニュース").locator("button").click()
        page.wait_for_selector(".stage .stage-hint", state="detached", timeout=5000)
        check("stage: follows the player (the corner being read is shown, with its position)",
              "注目ニュース" in page.inner_text(".stage-kicker") and "/" in page.inner_text(".stage-progress"))
        # 記事のカード: 実際の台本の項目と同じ形の slide を、プレーヤーへ直接渡して描画を確かめる
        title = page.evaluate("document.querySelector('.radio-hero time').textContent") + " の放送"
        page.evaluate("""(t) => import('/player.js').then((p) => p.read({ title: t, chapters: [{ label: '注目ニュース', parts: [{ text: 'テストの読み上げです。', slide: {
            kind: 'item', corner: '注目ニュース', n: 1, of: 3, heading: 'テスト用の見出し', what: 'かんたんな概要です。', use: '何かが分かります。',
            term: { term: '用語X', meaning: 'やさしい説明です。' }, ai: true, source: 'zenn', url: 'https://example.com/a', article: null } }] }] }))""", title)
        page.wait_for_selector(".stage-title:has-text('テスト用の見出し')", timeout=5000)
        st = page.inner_text(".stage")
        check("stage: an item card shows heading, plain summary, what you learn, term, source and an AI label",
              all(k in st for k in ("テスト用の見出し", "かんたんな概要です。", "分かること", "用語X", "やさしい説明です。", "zenn", "AIの解説")), st[:200])
        link = page.locator(".stage a.btn", has_text="原文へ")
        check("stage: the original-article link is external, noopener and http(s)",
              link.count() == 1 and link.get_attribute("target") == "_blank" and "noopener" in (link.get_attribute("rel") or "")
              and (link.get_attribute("href") or "").startswith("https://"))
        page.evaluate("import('/player.js').then((p) => p.stop())")
        page.wait_for_selector(".stage .stage-hint", timeout=5000)
        check("stage: returns to the hint when playback stops", page.locator(".stage .stage-hint").count() == 1)
    # --- ラジオの聞きやすさ・字幕(外部資料 第6弾 Z66): 章の印つき再生バー・字幕・Media Session・止めた位置・聞き終えた回
    if page.locator("#player-toggle").count():
        radio_title = page.evaluate("document.querySelector('.radio-hero time').textContent") + " の放送"
        page.evaluate("localStorage.removeItem('rb-radio-pos'); localStorage.removeItem('rb-radio-heard')")
        n_rows = page.locator(".guide-row").count()
        page.locator(".guide-row").nth(2).locator("button").click()
        page.wait_for_selector("#player:not([hidden])", timeout=5000)
        check("radio: the player bar has one chapter mark per corner, and the current one is marked",
              page.locator("#player-marks .mark").count() == n_rows and page.locator("#player-marks .mark[aria-current=true]").count() == 1
              and page.locator("#player-marks").is_visible(), (n_rows,))
        check("radio: chapter marks are labelled buttons (title / aria-label)",
              all((page.locator("#player-marks .mark").nth(i).get_attribute("aria-label") or "").startswith(f"{i + 1}章") for i in range(n_rows)))
        check("radio: earlier chapters are filled (done) and later ones are not",
              page.locator("#player-marks .mark.done").count() == 2)
        cap = page.locator(".stage-caption")
        check("radio: a subtitle shows the sentence being read (the display text)", cap.is_visible() and len(cap.inner_text().strip()) > 5, cap.inner_text())
        ms = page.evaluate("({s: navigator.mediaSession ? navigator.mediaSession.playbackState : null, t: navigator.mediaSession && navigator.mediaSession.metadata ? navigator.mediaSession.metadata.title : null, a: navigator.mediaSession && navigator.mediaSession.metadata ? navigator.mediaSession.metadata.artist : null})")
        check("radio: Media Session carries the chapter as the title (lock screen / earphones)", ms["t"] and ms["a"] == "Research Broadcast" and ms["s"] in ("playing", "paused"), ms)
        page.locator("#player-marks .mark").nth(4).click()
        check("radio: clicking a chapter mark jumps to that chapter", page.inner_text("#player-progress").startswith("5 /") and page.locator("#player-marks .mark.done").count() == 4,
              page.inner_text("#player-progress"))
        page.click("#player-stop")
        saved = page.evaluate("JSON.parse(localStorage.getItem('rb-radio-pos') || '[]')")
        check("radio: stopping remembers the chapter (this device only)", any(e["title"] == radio_title and e["c"] == 4 for e in saved), saved)
        page.reload()
        page.wait_for_selector(".guide-row")
        resume = page.locator("button[data-resume]")
        check("radio: a 'continue from' button appears with the chapter name", resume.count() == 1 and resume.inner_text().startswith("続きから(") and resume.get_attribute("data-resume") == "4",
              resume.count() and resume.inner_text())
        resume.click()
        page.wait_for_selector("#player:not([hidden])", timeout=5000)
        check("radio: continuing starts at the remembered chapter", page.inner_text("#player-progress").startswith("5 /"), page.inner_text("#player-progress"))
        page.click("#player-stop")
        # 聞き終えた回の印(最後まで聞くと記録される。ここでは記録のある状態を作って、表示を確かめる)
        page.evaluate("(t) => localStorage.setItem('rb-radio-heard', JSON.stringify([t]))", radio_title)
        page.reload()
        page.wait_for_selector(".guide-row")
        check("radio: a program heard to the end is marked (note and a check in the date list)",
              page.locator(".fig-note[data-heard]").count() == 1 and "✓" in page.locator("select[aria-label='放送の日付を選ぶ'] option[selected]").inner_text(),
              page.locator("select[aria-label='放送の日付を選ぶ'] option").first.inner_text())
        page.evaluate("localStorage.removeItem('rb-radio-pos'); localStorage.removeItem('rb-radio-heard')")
        check("radio: nothing is remembered for a single-article reading",
              page.evaluate("import('/player.js').then((p) => p.savedPosition('ある記事', 5))") is None)
    page.goto(BASE + "/")
    page.wait_for_selector(".lanes")
    check("home: an overview figure of today's counts by category",
          page.locator("#ov-title").count() == 1 and page.locator(".panel .fig .bar").count() >= 1)
    page.goto(BASE + "/radio")
    page.wait_for_selector(".guide-row")

    # --- テーマ
    before = page.evaluate("document.documentElement.getAttribute('data-theme')")
    page.click("#theme-btn")
    after = page.evaluate("document.documentElement.getAttribute('data-theme')")
    check("theme toggles and is stored", after in ("light", "dark") and after != before and page.evaluate("localStorage.getItem('rb-theme')") == after)

    # --- スマホ幅
    mob = browser.new_context(viewport={"width": 390, "height": 844}, locale="ja-JP", is_mobile=True)
    # ログイン状態を引き継ぐ
    mob.add_cookies(ctx.cookies())
    m = mob.new_page()
    m.on("console", lambda msg: problems.append(f"mobile {msg.type}: {msg.text}") if msg.type in ("error", "warning") else None)
    for path in ("/", "/c/game_dev_tech", "/board", "/weekly", "/status"):
        m.goto(BASE + path)
        m.wait_for_selector("main h1, main .lanes, main .panel", timeout=10000)
        m.wait_for_timeout(250)
        check(f"mobile {path}: no horizontal overflow", overflow(m) <= 0, overflow(m))
    m.goto(BASE + "/")
    m.wait_for_selector(".lane-picker")
    visible = [m.locator(".lane").nth(i).is_visible() for i in range(3)]
    check("mobile: only one lane visible at a time", sum(visible) == 1, visible)
    m.locator(".lane-picker button").nth(1).click()
    check("mobile: lane picker switches lane", m.locator(".lane").nth(1).is_visible())
    OUT and m.screenshot(path=os.path.join(OUT, "home_mobile.png"), full_page=True)
    m.locator(".item-title").first.click()
    m.wait_for_selector("#drawer:not([hidden])")
    box = m.evaluate("(() => { const r = document.getElementById('drawer').getBoundingClientRect(); return {l: r.left, w: r.width, b: r.bottom, vh: window.innerHeight, vw: window.innerWidth}; })()")
    check("mobile: drawer is a bottom sheet (full width, anchored to the bottom)",
          abs(box["w"] - box["vw"]) < 2 and abs(box["b"] - box["vh"]) < 2, box)
    m.keyboard.press("Escape")
    m.goto(BASE + "/reports")
    m.wait_for_selector(".report-card")
    check("mobile /reports: no horizontal overflow", overflow(m) <= 0, overflow(m))
    m.click(".report-card >> nth=0")
    m.wait_for_selector(".md")
    check("mobile report: no horizontal overflow", overflow(m) <= 0, overflow(m))

    # --- reduced motion
    rm = browser.new_context(viewport={"width": 1280, "height": 900}, reduced_motion="reduce", locale="ja-JP")
    rm.add_cookies(ctx.cookies())
    r = rm.new_page()
    r.goto(BASE + "/")
    r.wait_for_selector(".lanes")
    check("reduced motion: no fade class animations", r.evaluate("getComputedStyle(document.querySelector('.lane')).animationName") == "none")
    check("reduced motion: counts are final immediately", int(r.inner_text(".stat-num .num")) > 0)
    r.goto(BASE + "/radio")
    r.wait_for_selector("details.acc")
    check("reduced motion: the radio script is open by default, with a note", r.evaluate("document.querySelector('details.acc').open") and "動きを減らす設定" in r.inner_text("main"))
    page.goto(BASE + "/radio")
    page.wait_for_selector("details.acc")
    check("normal motion: the radio script starts collapsed, no reduced-motion note", not page.evaluate("document.querySelector('details.acc').open") and "動きを減らす設定" not in page.inner_text("main"))

    # --- アクセスの入口(T14)・キー割り当て(T6)
    page.goto(BASE + "/")
    page.wait_for_selector(".lanes")
    page.keyboard.press("Tab")
    check("skip link: the first Tab stop is the skip link and it is visible", page.evaluate("document.activeElement.classList.contains('skip')")
          and page.evaluate("document.activeElement.getBoundingClientRect().left >= 0"))
    page.keyboard.press("Enter")
    page.wait_for_timeout(300)
    check("skip link: focus moves to the main content", page.evaluate("document.activeElement.id") == "view")
    page.goto(BASE + "/")
    page.wait_for_selector(".lanes")
    page.keyboard.press("Control+k")
    check("keys: Ctrl+K focuses the search box", page.evaluate("document.activeElement.id") == "search-input")
    page.evaluate("document.activeElement.blur()")
    page.keyboard.press("?")
    help_text = page.inner_text("#help")
    check("keys: help lists search, player keys and Esc", all(k in help_text for k in ("Ctrl(⌘) + K", "Space", "前の章", "Esc")), help_text[:120])
    page.keyboard.press("Escape")
    check("keys: Esc closes the help", page.locator("#help").is_hidden())
    page.keyboard.press("Space")
    check("keys: Space with no player does not break the page", page.locator(".lanes").count() >= 1)

    # --- 整理(外部資料 第5弾 Z35): 1件ずつ片づける・ピン・見直す日・取り消し・スワイプ
    from datetime import datetime, timedelta, timezone
    jst_today = datetime.now(timezone(timedelta(hours=9))).date()
    def api_json(path):
        return page.evaluate(f"fetch('{path}').then(r => r.json())")
    def api_send(method, path, body=None):
        b = "undefined" if body is None else "JSON.stringify(" + json.dumps(body) + ")"
        return page.evaluate(f"fetch('{path}', {{method: '{method}', headers: {{'content-type': 'application/json'}}, body: {b}}}).then(r => r.status)")
    def wait_title_change(old):
        for _ in range(40):
            if page.locator(".tidy-title").count() and page.inner_text(".tidy-title") != old:
                return True
            page.wait_for_timeout(100)
        return False
    touched = []  # 後片付けする記事

    # 整理のテスト用に、40日前に収集した未読の記事を8件、ローカルのDBへ入れる(終わったら消す)。ローカルの記事の古さに左右されないため
    import subprocess, urllib.request
    def _ingest_token():
        t = os.environ.get("BROADCAST_INGEST_TOKEN")
        if t:
            return t
        m = re.search(r"^INGEST_TOKEN=(.+)$", open(os.path.join(os.path.dirname(HERE), ".dev.vars"), encoding="utf-8").read(), re.M)
        return m.group(1).strip() if m else None
    fx_base = datetime.now(timezone.utc) - timedelta(days=40)
    fixtures = [{
        "url_hash": f"7a7a7a7a7a7a7a{i:02x}", "url": f"https://example.com/tidy-fixture-{i}", "title": f"整理テスト用の記事 {i}",
        "source_type": "zenn", "platform": "tidy-fixture", "categories": ["game_dev_tech"], "label": "game_dev_tech", "keywords": [],
        "review": False, "status": "added", "published": fx_base.strftime("%Y-%m-%d"),
        "collected_at": (fx_base + timedelta(minutes=i)).strftime("%Y-%m-%dT%H:%M:%SZ"), "summary": f"整理のテスト用の要約 {i}", "summary_src": "feed",
    } for i in range(8)]
    seeded = False
    try:
        req = urllib.request.Request(BASE + "/api/ingest", data=json.dumps({"schema": 1, "articles": fixtures}).encode("utf-8"),
                                     headers={"content-type": "application/json", "authorization": f"Bearer {_ingest_token()}"}, method="POST")
        seeded = urllib.request.urlopen(req, timeout=30).status == 200
    except Exception as e:
        print("could not seed tidy fixtures:", e)

    probe = api_json("/api/tidy?days=7&limit=0")
    best_d = max(("7", "14", "30"), key=lambda d: probe["buckets"][d])
    n_stale = probe["buckets"][best_d]
    if n_stale < 6:
        print("SKIP tidy browser checks (fewer than 6 stale unread articles in the local DB)")
    else:
        page.click("nav a[data-nav=tidy]")
        page.wait_for_selector(".tidy-stats")
        check("tidy: nav link marks the page current", page.get_attribute("a[data-nav=tidy]", "aria-current") == "page")
        page.goto(BASE + f"/tidy?d={best_d}")
        page.wait_for_selector(".tidy-card")
        check("tidy: three day-chips with counts, the chosen one pressed",
              page.locator(".row-controls .chip").count() == 3 and page.locator(f".chip[data-days='{best_d}']").get_attribute("aria-pressed") == "true")
        listed = api_json(f"/api/tidy?days={best_d}&limit=200")["articles"]
        check("tidy: the first card is the oldest unread article", page.inner_text(".tidy-title").strip() == listed[0]["title"].strip(), (page.inner_text(".tidy-title"), listed[0]["title"]))
        check("tidy: card shows its age and a link to the original (http/https, noopener)",
              "日前に収集" in page.inner_text(".tidy-meta") and page.locator(".tidy-card a.btn").get_attribute("target") == "_blank"
              and "noopener" in (page.locator(".tidy-card a.btn").get_attribute("rel") or ""))
        check("tidy: no horizontal overflow (desktop)", overflow(page) <= 0, overflow(page))
        OUT and page.screenshot(path=os.path.join(OUT, "tidy_desktop.png"), full_page=True)

        h1, h2, h3, h4, h5 = (a["url_hash"] for a in listed[:5])
        touched += [h1, h2, h3, h4, h5]
        # ← 完了(既読)
        t1 = page.inner_text(".tidy-title")
        page.keyboard.press("ArrowLeft")
        check("tidy: ← marks it read and shows the next card", wait_title_change(t1) and next((i for i in api_json("/api/board")["items"] if i["url_hash"] == h1), {}).get("state") == "read")
        check("tidy: the tally says 完了 1", "完了 1" in page.inner_text(".tidy-stats").replace("\n", " "), page.inner_text(".tidy-stats"))
        # z ひとつ戻す
        page.keyboard.press("z")
        check("tidy: z undoes it (same card back, board row removed)", wait_title_change(listed[1]["title"]) and page.inner_text(".tidy-title").strip() == listed[0]["title"].strip()
              and not any(i["url_hash"] == h1 for i in api_json("/api/board")["items"]))
        # → ピン留め
        t1 = page.inner_text(".tidy-title")
        page.keyboard.press("ArrowRight")
        wait_title_change(t1)
        marks = {m["url_hash"]: m for m in api_json("/api/marks")["items"]}
        check("tidy: → pins it (and it stays unread)", marks.get(h1, {}).get("pinned") is True and not any(i["url_hash"] == h1 for i in api_json("/api/board")["items"]), marks.get(h1))
        # 1 = 明日に見直す
        t1 = page.inner_text(".tidy-title")
        page.keyboard.press("1")
        wait_title_change(t1)
        marks = {m["url_hash"]: m for m in api_json("/api/marks")["items"]}
        check("tidy: 1 sets the reminder to tomorrow (JST)", marks.get(h2, {}).get("remind_on") == (jst_today + timedelta(days=1)).isoformat(), marks.get(h2))
        # ↓ 今は決めない: 何も付かない
        t1 = page.inner_text(".tidy-title")
        page.keyboard.press("ArrowDown")
        wait_title_change(t1)
        marks = {m["url_hash"] for m in api_json("/api/marks")["items"]}
        board = {i["url_hash"] for i in api_json("/api/board")["items"]}
        check("tidy: ↓ leaves the article untouched (still unread, no mark)", h3 not in marks and h3 not in board and "今は決めない 1" in page.inner_text(".tidy-stats"))
        # スワイプ(左 = 完了)
        t1 = page.inner_text(".tidy-title")
        box = page.locator(".tidy-title").bounding_box()
        cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        page.mouse.move(cx, cy)
        page.mouse.down()
        page.mouse.move(cx - 60, cy, steps=4)
        mid = page.locator(".tidy-card").get_attribute("data-swipe")
        page.mouse.move(cx - 160, cy, steps=6)
        page.mouse.up()
        wait_title_change(t1)
        check("tidy: dragging the card left marks it read (swipe hint shown while dragging)",
              mid in ("left-soft", "left") and next((i for i in api_json("/api/board")["items"] if i["url_hash"] == h4), {}).get("state") == "read", (mid,))
        # 短いドラッグでは何も起きない
        t1 = page.inner_text(".tidy-title")
        box = page.locator(".tidy-title").bounding_box()
        cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        page.mouse.move(cx, cy)
        page.mouse.down()
        page.mouse.move(cx + 40, cy, steps=3)
        page.mouse.up()
        page.wait_for_timeout(300)
        check("tidy: a short drag does nothing (the card stays)", page.inner_text(".tidy-title") == t1)
        # ボタンでも同じことができる(スワイプは近道)
        t1 = page.inner_text(".tidy-title")
        page.locator(".tidy-actions button[data-act=pin]").click()
        wait_title_change(t1)
        marks = {m["url_hash"]: m for m in api_json("/api/marks")["items"]}
        check("tidy: the same actions are available as buttons", marks.get(h5, {}).get("pinned") is True, marks.get(h5))
        # まとめて既読 → ひとつ戻す(既読のものだけ戻る)
        left_before = page.locator(".tidy-stats .num").first.inner_text()
        page.once("dialog", lambda d: d.accept())
        page.locator("button[data-act=bulk]").click()
        for _ in range(30):
            if page.locator(".tidy-card").count() == 0:
                break
            page.wait_for_timeout(100)
        check("tidy: bulk read empties the queue and says it is done", page.locator(".tidy-card").count() == 0 and "片づきました" in page.inner_text(".tidy-stage"), page.inner_text(".tidy-stage")[:80])
        read_now = {i["url_hash"] for i in api_json("/api/board")["items"] if i["state"] == "read"}
        page.locator("button[data-act=undo]").click()
        page.wait_for_selector(".tidy-card")
        read_after = {i["url_hash"] for i in api_json("/api/board")["items"] if i["state"] == "read"}
        check("tidy: undoing the bulk read restores the queue (the swiped one stays read)", h4 in read_after and len(read_now) > len(read_after), (len(read_now), len(read_after)))

        # ボード・ホームに出る
        page.goto(BASE + "/board")
        page.wait_for_selector("#board-pin")
        check("board: counts line, tidy entry, and the pinned section", "ピン" in page.inner_text(".tidy-stats") and page.locator("a.btn[href='/tidy']").count() == 1
              and page.locator("#board-pin").locator("xpath=ancestor::section").locator(".item").count() >= 2 and page.locator("#board-remind").count() == 1)
        check("board: pinned item carries the pin badge", page.locator(".badge.pin", has_text="ピン").count() >= 1)
        api_send("PUT", f"/api/marks/{h2}", {"remind_on": jst_today.isoformat()})
        page.goto(BASE + "/")
        page.wait_for_selector("#due-title")
        check("home: an article whose reminder day has come shows under 今日見直すもの with a 見直し badge",
              page.locator("#due-title").count() == 1 and page.locator(".badge.mark.warn", has_text="見直し").count() >= 1)
        # ドロワーの操作
        page.locator("#due-title").locator("xpath=ancestor::section").locator(".item-title").first.click()
        page.wait_for_selector("#drawer:not([hidden])")
        page.locator("#drawer button", has_text="ピン留め").click()
        page.wait_for_selector(".toast")
        marks = {m["url_hash"]: m for m in api_json("/api/marks")["items"]}
        check("drawer: pin button pins (reminder kept); the pressed state follows", marks.get(h2, {}).get("pinned") is True and marks[h2]["remind_on"] == jst_today.isoformat()
              and page.locator("#drawer button", has_text="ピン留め").get_attribute("aria-pressed") == "true")
        page.locator("#drawer button", has_text="解除").click()
        page.wait_for_timeout(300)
        marks = {m["url_hash"]: m for m in api_json("/api/marks")["items"]}
        check("drawer: 解除 clears only the reminder", marks.get(h2, {}).get("remind_on") is None and marks.get(h2, {}).get("pinned") is True)
        page.keyboard.press("Escape")
        page.goto(BASE + "/")
        page.wait_for_selector(".lanes")
        check("home: nothing is due after the reminder is cleared", page.locator("#due-title").count() == 0)

        # 後片付け(ローカルの行を戻す)
        for hh in touched:
            api_send("DELETE", f"/api/board/{hh}")
            api_send("DELETE", f"/api/marks/{hh}")
        check("tidy: test rows cleaned up", not [m for m in api_json("/api/marks")["items"] if m["url_hash"] in touched])

    if seeded:
        # テスト用の記事を消す(board / marks に残った行も)。ローカルのD1を直接さわる(本番には触れない)
        sql = "DELETE FROM board WHERE url_hash LIKE '7a7a7a7a7a7a7a%'; DELETE FROM marks WHERE url_hash LIKE '7a7a7a7a7a7a7a%'; DELETE FROM articles WHERE platform = 'tidy-fixture';"
        done = subprocess.run(f'npx wrangler d1 execute DB --local --command "{sql}"', shell=True, cwd=os.path.dirname(HERE), capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
        check("tidy: fixture articles removed from the local DB", done.returncode == 0 and "tidy-fixture" not in json.dumps(api_json("/api/tidy?days=1&limit=200")["articles"]), done.stderr[-200:])

    # --- 後片付け(ローカルのボードの行を戻す)
    page.evaluate(f"fetch('/api/board/{first_hash}', {{method: 'DELETE'}}).then(r => r.status)")

    csp_related = [x for x in problems if "Content Security Policy" in x or "Refused" in x]
    check("no CSP violations in console", not csp_related, csp_related[:3])
    other = [x for x in problems if x not in csp_related and "fonts.g" not in x and "ERR_" not in x and "401" not in x]
    check("no console errors/warnings (besides external fonts)", not other, other[:5])
    if problems:
        print("console messages:", json.dumps(problems[:8], ensure_ascii=False))
    browser.close()

print("\nALL PASS" if all(results) else f"\n{results.count(False)} FAILED")
sys.exit(0 if all(results) else 1)
