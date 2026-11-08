// ラジオの「止めた位置」と「聞き終えた回」の記憶(radio-memory.js)の単体テスト。ブラウザ不要。
import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_HEARD, MAX_POSITIONS, clearPosition, getPosition, heardSet, markHeard, savePosition } from "../public/radio-memory.js";

const fake = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, v), raw: m };
};
const T = "2026-11-08 の放送";

test("savePosition / getPosition: remembers the chapter, overwrites the same program", () => {
  const s = fake();
  assert.equal(getPosition(s, T, 8), null);
  savePosition(s, T, { c: 3, label: "ゲーム開発のコーナー" }, 1000);
  assert.deepEqual(getPosition(s, T, 8), { c: 3, label: "ゲーム開発のコーナー", at: 1000 });
  savePosition(s, T, { c: 5, label: "おさらい" }, 2000);
  assert.equal(getPosition(s, T, 8).c, 5);
  assert.equal(JSON.parse(s.raw.get("rb-radio-pos")).length, 1); // 同じ回は1件のまま
});

test("getPosition: a position outside the program (the content changed) is ignored", () => {
  const s = fake();
  savePosition(s, T, { c: 7, label: "x" });
  assert.equal(getPosition(s, T, 7), null); // 章が7つに減った
  assert.equal(getPosition(s, T, 8).c, 7);
});

test("clearPosition removes only that program", () => {
  const s = fake();
  savePosition(s, "A の放送", { c: 1, label: "a" });
  savePosition(s, "B の放送", { c: 2, label: "b" });
  clearPosition(s, "A の放送");
  assert.equal(getPosition(s, "A の放送", 9), null);
  assert.equal(getPosition(s, "B の放送", 9).c, 2);
});

test("positions are capped, oldest dropped first", () => {
  const s = fake();
  for (let i = 0; i < MAX_POSITIONS + 5; i++) savePosition(s, `D${i} の放送`, { c: 1, label: "x" }, i);
  const list = JSON.parse(s.raw.get("rb-radio-pos"));
  assert.equal(list.length, MAX_POSITIONS);
  assert.equal(getPosition(s, "D0 の放送", 9), null); // いちばん古い
  assert.ok(getPosition(s, `D${MAX_POSITIONS + 4} の放送`, 9));
});

test("markHeard: unique, capped, and visible through heardSet", () => {
  const s = fake();
  markHeard(s, T);
  markHeard(s, T);
  assert.deepEqual([...heardSet(s)], [T]);
  for (let i = 0; i < MAX_HEARD + 3; i++) markHeard(s, `D${i} の放送`);
  const set = heardSet(s);
  assert.equal(set.size, MAX_HEARD);
  assert.ok(!set.has(T) && set.has(`D${MAX_HEARD + 2} の放送`));
});

test("bad input and broken storage never throw (nothing is remembered)", () => {
  const s = fake({ "rb-radio-pos": "{not json", "rb-radio-heard": '{"a":1}' });
  assert.equal(getPosition(s, T, 8), null);
  assert.equal(heardSet(s).size, 0);
  savePosition(s, "", { c: 1, label: "x" });
  savePosition(s, T, { c: -1, label: "x" });
  savePosition(s, T, { c: 1.5, label: "x" });
  markHeard(s, "");
  assert.equal(getPosition(s, T, 8), null);
  const bad = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.doesNotThrow(() => { savePosition(bad, T, { c: 1, label: "x" }); markHeard(bad, T); clearPosition(bad, T); });
  assert.equal(getPosition(bad, T, 8), null);
  assert.equal(heardSet(bad).size, 0);
});

test("entries with the wrong shape are dropped, and '__proto__' as a title is harmless", () => {
  const s = fake({ "rb-radio-pos": JSON.stringify([{ title: 5, c: 1 }, { title: "ok の放送", c: 2, label: "z", at: 1 }, null, { title: "neg", c: -3 }]) });
  assert.equal(getPosition(s, "ok の放送", 9).c, 2);
  assert.equal(getPosition(s, "neg", 9), null);
  savePosition(s, "__proto__", { c: 1, label: "p" });
  assert.equal(getPosition(s, "__proto__", 9).c, 1);
  assert.equal({}.c, undefined); // 汚染されていない
});
