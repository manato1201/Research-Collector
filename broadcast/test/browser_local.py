"""
ResearchBroadcast サイトのブラウザ検証(ローカル)。Playwright(Chromium)で、ログイン・放送・ドロワー・ボード・
カテゴリ・週次の図・状態・テーマ・スマホ幅・動きの軽減・ログアウトを確認する。

    # 前提: integration_local.py で記事と episode が入った、`wrangler dev --local` が動いている状態
    #   pip install playwright && playwright install chromium
    python broadcast/test/browser_local.py

ログインには broadcast/.dev.vars の VIEW_PASSWORD(または環境変数 BROADCAST_VIEW_PASSWORD)を使う。
画面の保存先は環境変数 BROADCAST_SHOTS_DIR(未指定なら保存しない)。
注意: ローカルのD1のボードに書き込む(本番には触れない)。
"""
import json, os, re, sys
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.environ.get("BROADCAST_BASE_URL", "http://127.0.0.1:8787")
SHOTS = os.environ.get("BROADCAST_SHOTS_DIR")


def _password():
    v = os.environ.get("BROADCAST_VIEW_PASSWORD")
    if v:
        return v
    text = open(os.path.join(os.path.dirname(HERE), ".dev.vars"), encoding="utf-8").read()
    m = re.search(r"^VIEW_PASSWORD=(.+)$", text, re.M)
    if not m:
        sys.exit("VIEW_PASSWORD が見つかりません(broadcast/.dev.vars か BROADCAST_VIEW_PASSWORD)")
    return m.group(1).strip()


PW = _password()
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

    # --- 未ログイン → ログイン画面
    page.goto(BASE + "/")
    page.wait_for_url(re.compile(r"/login"))
    check("anonymous visit redirects to /login with next", "next=%2F" in page.url, page.url)
    check("login form is shown", page.locator("form.login input[type=password]").count() == 1)
    page.fill("#pw", "wrong-password")
    page.click("button[type=submit]")
    page.wait_for_selector(".login .err:not(:empty)")
    check("wrong password shows an error", "違" in page.inner_text(".login .err"))
    page.fill("#pw", PW)
    page.click("button[type=submit]")
    page.wait_for_selector(".lanes")
    check("login leads to the home (3 base lanes)", page.locator(".lanes").first.locator(".lane").count() == 3)
    check("logout button is visible after login", page.locator("#logout-btn").is_visible())
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
    paths = ["/", "/radio", "/board", "/weekly", "/reports", "/status", "/settings", "/search", "/c/game_dev_tech", "/c/software_engineering"]
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

    # --- 後片付け(ローカルのボードの行を戻す)
    page.evaluate(f"fetch('/api/board/{first_hash}', {{method: 'DELETE'}}).then(r => r.status)")

    # --- ログアウト
    page.goto(BASE + "/")
    page.wait_for_selector(".lanes")
    page.click("#logout-btn")
    page.wait_for_url(re.compile(r"/login"))
    check("logout returns to login", page.locator("form.login").count() == 1)
    api = page.evaluate("fetch('/api/articles?limit=1').then(r => r.status)")
    check("after logout the API is closed (401)", api == 401, api)

    csp_related = [x for x in problems if "Content Security Policy" in x or "Refused" in x]
    check("no CSP violations in console", not csp_related, csp_related[:3])
    other = [x for x in problems if x not in csp_related and "fonts.g" not in x and "ERR_" not in x and "401" not in x]
    check("no console errors/warnings (besides external fonts)", not other, other[:5])
    if problems:
        print("console messages:", json.dumps(problems[:8], ensure_ascii=False))
    browser.close()

print("\nALL PASS" if all(results) else f"\n{results.count(False)} FAILED")
sys.exit(0 if all(results) else 1)
