// アイコンの整合を、ブラウザを使わずに確かめる。
//  - index.html の data-icon が、icons.js に実在する名前を指している
//  - JS の中で icon("...") / setLabel(el, "...", ...) が呼ぶ名前が、実在する
//  - すべてのアイコンが、24×24 の座標に収まる図形だけでできている
//  - 動き: 新しい無限ループ(infinite)を、アイコンの節に足していない
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ICONS } from "../public/icons.js";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const html = readFileSync(join(PUBLIC, "index.html"), "utf8");
const css = readFileSync(join(PUBLIC, "style.css"), "utf8");
const jsFiles = readdirSync(PUBLIC).filter((f) => f.endsWith(".js") && f !== "icons.js" && f !== "sw.js");

test("every data-icon in index.html names a real icon", () => {
  const names = [...html.matchAll(/data-icon="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/));
  assert.ok(names.length >= 10, "data-icon が少なすぎる");
  const missing = names.filter((n) => !(n in ICONS));
  assert.deepEqual(missing, []);
});

test("every icon(...) / setLabel(...) call in the scripts names a real icon", () => {
  const missing = [];
  for (const f of jsFiles) {
    const text = readFileSync(join(PUBLIC, f), "utf8");
    for (const m of text.matchAll(/\bicon\(\s*"([\w-]+)"/g)) if (!(m[1] in ICONS)) missing.push(`${f}: ${m[1]}`);
    for (const m of text.matchAll(/setLabel\([^,]+,\s*"([\w-]+)"/g)) if (!(m[1] in ICONS)) missing.push(`${f}: ${m[1]}`);
    for (const m of text.matchAll(/\bicon\(\s*[^")]*\?\s*"([\w-]+)"\s*:\s*"([\w-]+)"/g)) {
      for (const n of [m[1], m[2]]) if (!(n in ICONS)) missing.push(`${f}: ${n}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("icons are drawn with simple shapes inside the 24x24 box", () => {
  for (const [name, parts] of Object.entries(ICONS)) {
    assert.ok(parts.length > 0, name);
    for (const [tag, attrs] of parts) {
      assert.ok(["path", "circle", "rect"].includes(tag), `${name}: ${tag}`);
      if (tag === "circle") {
        assert.ok(attrs.cx - attrs.r >= 0 && attrs.cx + attrs.r <= 24, `${name} cx`);
        assert.ok(attrs.cy - attrs.r >= 0 && attrs.cy + attrs.r <= 24, `${name} cy`);
      }
      if (tag === "rect") {
        assert.ok(attrs.x >= 0 && attrs.x + attrs.width <= 24 && attrs.y >= 0 && attrs.y + attrs.height <= 24, `${name} rect`);
      }
    }
  }
});

test("the icon section adds no infinite animation and every animation is guarded by reduced motion", () => {
  const section = css.slice(css.indexOf("アイコンと、ちいさな遊び"));
  assert.ok(section.length > 500);
  assert.ok(!/infinite/.test(section), "新しい無限ループは足さない");
  // animation: を含む規則は、no-preference のブロックの中にある
  const guarded = section.slice(section.indexOf("@media (prefers-reduced-motion: no-preference)"), section.indexOf("@keyframes ico-wiggle"));
  const outside = section.replace(guarded, "");
  const keyframes = outside.slice(outside.indexOf("@keyframes ico-wiggle"));
  const rest = outside.replace(keyframes, "");
  assert.ok(!/animation\s*:/.test(rest), "animation は no-preference の中だけ");
});

test("the open/leave motion section is one-shot, guarded by reduced motion, and moves only transform and opacity", () => {
  const section = css.slice(css.indexOf("開く・出る・増える"));
  assert.ok(section.length > 300);
  assert.ok(!/infinite/.test(section), "新しい無限ループは足さない");
  const at = section.indexOf("@keyframes");
  const guarded = section.slice(section.indexOf("@media (prefers-reduced-motion: no-preference)"), at);
  assert.ok(/animation\s*:/.test(guarded));
  assert.ok(!/animation\s*:/.test(section.replace(guarded, "").slice(0, section.replace(guarded, "").indexOf("@keyframes"))), "animation は no-preference の中だけ");
  for (const body of section.slice(at).matchAll(/\{([^{}]*)\}/g)) {
    for (const prop of body[1].split(";").map((d) => d.split(":")[0].trim()).filter(Boolean)) {
      assert.ok(["transform", "opacity"].includes(prop), `動かしてはいけない性質: ${prop}`);
    }
  }
});
