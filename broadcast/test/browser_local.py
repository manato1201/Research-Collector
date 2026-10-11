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
    check("login leads to the home (lanes)", page.locator(".lane").count() == 3)
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
