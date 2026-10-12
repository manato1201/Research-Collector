// 読み上げプレーヤー — ブラウザの speechSynthesis(無料。声は端末・ブラウザによる)
//
// 設計(ResearchBroadcast_DESIGN.md §2.2 の「再生バー・章(チャプター)」を、音声ファイル無しで実現する):
//  - 読み上げる内容は「章(chapter)」の並び。章ごとにスキップできる。
//  - 長い文は途中で止まる実装がある(Chrome は約15秒で切れる)ため、短いかたまり(約140字)に分けて順に話す。
//  - 一時停止は pause() に頼らない(端末によって効かない)。止めて、再開時に今のかたまりを頭から話し直す。
//  - ページを移動しても続く(プレーヤーはページの外側にある)。ページを閉じると止まる。
//  - 速度・声は localStorage に覚える(使えなくても動く)。

const synth = "speechSynthesis" in window ? window.speechSynthesis : null;
export const supported = Boolean(synth);

const KEY_RATE = "rb-tts-rate";
const KEY_VOICE = "rb-tts-voice";
const CHUNK_MAX = 140;

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
const listeners = new Set();

/** 文末(。!?改行)で区切り、約 CHUNK_MAX 字ごとにまとめる。長い1文は読点・字数で割る。 */
export function splitChunks(text, max = CHUNK_MAX) {
  const sentences = String(text ?? "")
    .replace(/\s+/g, " ")
    .split(/(?<=[。！？!?\n])/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  let cur = "";
  const flush = () => {
    if (cur) out.push(cur);
    cur = "";
  };
  for (let s of sentences) {
    while (s.length > max) {
      // 読点で割れるなら割る。無ければ字数で割る
      let cut = s.lastIndexOf("、", max);
      if (cut < max / 3) cut = max - 1;
      flush();
      out.push(s.slice(0, cut + 1));
      s = s.slice(cut + 1);
    }
    if ((cur + s).length > max) flush();
    cur += s;
  }
  flush();
  return out;
}

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
  };
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function pickVoice() {
  const voices = synth.getVoices();
  return (
    voices.find((v) => v.name === voiceName) ??
    voices.find((v) => v.lang?.toLowerCase().startsWith("ja")) ??
    null
  );
}

function finish() {
  token++;
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
export function read({ title: t, chapters }) {
  if (!supported) return false;
  const q = (chapters ?? [])
    .map((c) => ({ label: c.label, chunks: splitChunks(c.text) }))
    .filter((c) => c.chunks.length > 0);
  if (q.length === 0) return false;
  token++;
  synth.cancel();
  queue = q;
  pos = { c: 0, k: 0 };
  title = t;
  status = "playing";
  speakCurrent();
  notify();
  return true;
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
  if (status === "playing") speakCurrent();
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
    speakCurrent();
  }
  notify();
}

export function setVoice(name) {
  voiceName = name;
  store.set(KEY_VOICE, name);
  if (status === "playing") {
    token++;
    synth.cancel();
    speakCurrent();
  }
  notify();
}

/** 日本語の声の一覧(端末にある分)。 */
export function japaneseVoices() {
  if (!supported) return [];
  return synth.getVoices().filter((v) => v.lang?.toLowerCase().startsWith("ja"));
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

  $("player-prev").addEventListener("click", () => jump(-1));
  $("player-next").addEventListener("click", () => jump(1));
  $("player-stop").addEventListener("click", () => stop());
  toggleBtn.addEventListener("click", () => toggle());
  rateSel.addEventListener("change", () => setRate(rateSel.value));
  voiceSel.addEventListener("change", () => setVoice(voiceSel.value));

  const fillVoices = () => {
    const ja = japaneseVoices();
    voiceSel.replaceChildren();
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = ja.length ? "声: 自動" : "声: 端末の既定";
    voiceSel.append(auto);
    for (const v of ja) {
      const o = document.createElement("option");
      o.value = v.name;
      o.textContent = v.name;
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
    titleEl.textContent = s.title;
    chapterEl.textContent = s.chapter;
    progressEl.textContent = s.chapterCount ? `${s.chapterIndex + 1} / ${s.chapterCount}` : "";
    toggleBtn.textContent = s.status === "playing" ? "一時停止" : "再生";
    toggleBtn.setAttribute("aria-pressed", String(s.status === "paused"));
  });

  window.addEventListener("pagehide", () => stop());
}
