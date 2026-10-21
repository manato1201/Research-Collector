// 読み上げプレーヤー — ブラウザの speechSynthesis(無料。声は端末・ブラウザによる)
//
// 設計(ResearchBroadcast_DESIGN.md §2.2 の「再生バー・章(チャプター)」を、音声ファイル無しで実現する):
//  - 読み上げる内容は「章(chapter)」の並び。章ごとにスキップできる。
//  - 長い文は途中で止まる実装がある(Chrome は約15秒で切れる)ため、短いかたまり(約140字)に分けて順に話す。
//  - 一時停止は pause() に頼らない(端末によって効かない)。止めて、再開時に今のかたまりを頭から話し直す。
//  - ページを移動しても続く(プレーヤーはページの外側にある)。ページを閉じると止まる。
//  - 速度・声は localStorage に覚える(使えなくても動く)。

import { splitChunks } from "./radio-script.js";
import { jingle } from "./sfx.js";
import { isHighQuality, pickBestVoice, rankVoices, voiceLabel } from "./voice.js";

const synth = "speechSynthesis" in window ? window.speechSynthesis : null;
export const supported = Boolean(synth);

const KEY_RATE = "rb-tts-rate";
const KEY_VOICE = "rb-tts-voice";
const KEY_SFX = "rb-tts-sfx";

const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* 保存できなくても動く */
    }
  },
};

let queue = []; // [{label, chunks: string[]}]
let pos = { c: 0, k: 0 };
let token = 0; // 古いコールバックを無視する
let status = "idle"; // idle | playing | paused
let title = "";
let rate = Number(store.get(KEY_RATE)) || 1;
let voiceName = store.get(KEY_VOICE) || "";
let sfxOn = store.get(KEY_SFX) !== "0"; // ジングル(効果音)。既定はオン
let sleepTimer = null; // setTimeout の id
let sleepAt = 0; // 停止する時刻(ms)。0 = なし
let jingleTimer = null;
const listeners = new Set();

function notify() {
  const snap = snapshot();
  listeners.forEach((fn) => fn(snap));
}

export function snapshot() {
  const total = queue.length;
  return {
    status,
    title,
    chapter: queue[pos.c]?.label ?? "",
    chapterIndex: pos.c,
    chapterCount: total,
    rate,
    voiceName,
    sfx: sfxOn,
    sleepAt,
  };
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// 声は、ユーザーが選んだものがあればそれ。無ければ「おまかせ」(いちばん自然そうな日本語の声。voice.js)
function pickVoice() {
  return pickBestVoice(synth.getVoices(), voiceName);
}

function finish() {
  token++;
  clearTimeout(jingleTimer);
  status = "idle";
  queue = [];
  pos = { c: 0, k: 0 };
  notify();
}

function advance() {
  const ch = queue[pos.c];
  if (!ch) return finish();
  pos.k++;
  if (pos.k >= ch.chunks.length) {
    pos = { c: pos.c + 1, k: 0 };
    if (pos.c >= queue.length) return finish();
  }
  speakCurrent();
  notify();
}

function speakCurrent() {
  const ch = queue[pos.c];
  const text = ch?.chunks[pos.k];
  if (text === undefined) return finish();
  // 章の最初では、ジングルを鳴らしてから話し始める(効果音がオフ・鳴らせない端末では、すぐ話す)
  if (pos.k === 0 && ch.jingle && sfxOn) {
    const ms = jingle(ch.jingle);
    if (ms > 0) {
      const mine = token;
      clearTimeout(jingleTimer);
      jingleTimer = setTimeout(() => {
        if (mine === token) speakChunk(text);
      }, ms);
      return;
    }
  }
  speakChunk(text);
}

function speakChunk(text) {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "ja-JP";
  u.rate = rate;
  const v = pickVoice();
  if (v) u.voice = v;
  const mine = token;
  u.onend = () => {
    if (mine === token) advance();
  };
  u.onerror = (e) => {
    if (mine !== token) return;
    if (e.error === "interrupted" || e.error === "canceled") return;
    advance(); // 読めないかたまりは飛ばして続ける
  };
  synth.speak(u);
}

/** chapters: [{label, text}]。空の章は飛ばす。読み始めたら true。 */
export function read({ title: t, chapters, startAt = 0 }) {
  if (!supported) return false;
  const q = (chapters ?? [])
    .map((c) => ({ label: c.label, jingle: c.jingle ?? null, chunks: splitChunks(c.text) }))
    .filter((c) => c.chunks.length > 0);
  if (q.length === 0) return false;
  token++;
  synth.cancel();
  queue = q;
  pos = { c: Math.min(Math.max(0, startAt), q.length - 1), k: 0 };
  title = t;
  status = "playing";
  speakSoon();
  notify();
  return true;
}

/**
 * cancel() の直後に speak() すると、Chrome で取りこぼされることがある。
 * 短く待ってから話し始める(その間に止められたら、token が変わるので話さない)。
 */
function speakSoon() {
  const mine = token;
  setTimeout(() => {
    if (mine === token) speakCurrent();
  }, 80);
}

export function pause() {
  if (status !== "playing") return;
  token++;
  synth.cancel();
  status = "paused";
  notify();
}

export function resume() {
  if (status !== "paused") return;
  status = "playing";
  speakCurrent();
  notify();
}

export function toggle() {
  if (status === "playing") pause();
  else if (status === "paused") resume();
}

export function jump(delta) {
  if (status === "idle") return;
  const c = pos.c + delta;
  if (c < 0 || c >= queue.length) return delta > 0 ? finish() : undefined;
  token++;
  synth.cancel();
  pos = { c, k: 0 };
  if (status === "playing") speakSoon();
  notify();
}

export function stop() {
  if (!supported) return;
  if (status === "idle") return;
  finish();
  synth.cancel();
}

export function setRate(r) {
  rate = Math.min(2, Math.max(0.5, Number(r) || 1));
  store.set(KEY_RATE, String(rate));
  if (status === "playing") {
    token++;
    synth.cancel();
    speakSoon();
  }
  notify();
}

export function setVoice(name) {
  voiceName = name;
  store.set(KEY_VOICE, name);
  if (status === "playing") {
    token++;
    synth.cancel();
    speakSoon();
  }
  notify();
}

/** minutes 分後に読み上げを止める。0 で解除。 */
export function setSleep(minutes) {
  clearTimeout(sleepTimer);
  sleepTimer = null;
  sleepAt = 0;
  const m = Number(minutes) || 0;
  if (m > 0) {
    sleepAt = Date.now() + m * 60_000;
    sleepTimer = setTimeout(() => {
      sleepAt = 0;
      stop();
      notify();
    }, m * 60_000);
  }
  notify();
}

export function setSfx(on) {
  sfxOn = Boolean(on);
  store.set(KEY_SFX, sfxOn ? "1" : "0");
  notify();
}

/** 日本語の声の一覧(端末にある分)。 */
export function japaneseVoices() {
  if (!supported) return [];
  return rankVoices(synth.getVoices());
}

// ------------------------------------------------------------------ 再生バー(DOM は index.html にある)

export function initPlayerUI() {
  const bar = document.getElementById("player");
  if (!bar) return;
  const $ = (id) => document.getElementById(id);
  const titleEl = $("player-title");
  const chapterEl = $("player-chapter");
  const progressEl = $("player-progress");
  const toggleBtn = $("player-toggle");
  const rateSel = $("player-rate");
  const voiceSel = $("player-voice");
  const noteEl = $("player-note");
  const sleepSel = $("player-sleep");
  const sfxBox = $("player-sfx");
  const lamp = $("player-lamp");

  $("player-prev").addEventListener("click", () => jump(-1));
  $("player-next").addEventListener("click", () => jump(1));
  $("player-stop").addEventListener("click", () => stop());
  toggleBtn.addEventListener("click", () => toggle());
  rateSel.addEventListener("change", () => setRate(rateSel.value));
  sleepSel.addEventListener("change", () => setSleep(sleepSel.value));
  sfxBox.checked = sfxOn;
  sfxBox.addEventListener("change", () => setSfx(sfxBox.checked));
  voiceSel.addEventListener("change", () => setVoice(voiceSel.value));

  const fillVoices = () => {
    const ja = japaneseVoices();
    voiceSel.replaceChildren();
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = ja.length ? `声: おまかせ(${ja[0].name}${isHighQuality(ja[0]) ? " ★" : ""})` : "声: 端末の既定";
    voiceSel.append(auto);
    for (const v of ja) {
      const o = document.createElement("option");
      o.value = v.name;
      o.textContent = voiceLabel(v);
      voiceSel.append(o);
    }
    voiceSel.value = ja.some((v) => v.name === voiceName) ? voiceName : "";
    noteEl.hidden = ja.length > 0;
  };
  if (supported) {
    fillVoices();
    synth.addEventListener?.("voiceschanged", fillVoices);
  }

  rateSel.value = String(rate);
  if (rateSel.value !== String(rate)) rateSel.value = "1";

  onChange((s) => {
    bar.hidden = s.status === "idle";
    document.body.classList.toggle("has-player", s.status !== "idle");
    // ON AIR: 再生中 = on / 一時停止 = paused / 停止 = off(ラジオのページの表示と同期する)
    document.body.dataset.air = s.status === "playing" ? "on" : s.status === "paused" ? "paused" : "off";
    lamp.textContent = s.status === "playing" ? "ON AIR" : s.status === "paused" ? "PAUSE" : "STANDBY";
    sfxBox.checked = s.sfx;
    if (!s.sleepAt) sleepSel.value = "0";
    titleEl.textContent = s.title;
    chapterEl.textContent = s.chapter;
    progressEl.textContent = s.chapterCount ? `${s.chapterIndex + 1} / ${s.chapterCount}` : "";
    toggleBtn.textContent = s.status === "playing" ? "一時停止" : "再生";
    toggleBtn.setAttribute("aria-pressed", String(s.status === "paused"));
  });

  window.addEventListener("pagehide", () => stop());
}
