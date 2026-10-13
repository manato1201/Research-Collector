// ラジオ原稿の生成(規則ベース。AI は使わない。DOM に依存しないので node でテストできる)
//
// 入力: その日の episode(件数・注目・カテゴリ別の記事)。出力: 番組(コーナーの並び)。
// 構成: オープニング → 注目ニュース → カテゴリ別のコーナー → エンディング。
// 話し言葉に整える: あいさつ(時間帯)・「まず / 続いて / さらに / 最後に」・コーナーの紹介・
// 英字の用語の読み(辞書)・URL や記号の除去。読み上げはブラウザの音声(player.js)。

/** 英字の用語 → 読み。端末の日本語音声は、英字をローマ字風に読むことがあるため、よく出る用語だけ直す。 */
export const READINGS = [
  [/Unreal Engine/gi, "アンリアルエンジン"],
  [/\bUE ?5\b/g, "ユーイーファイブ"],
  [/\bUE ?4\b/g, "ユーイーフォー"],
  [/\bUE\b/g, "ユーイー"],
  [/\bUnity\b/gi, "ユニティ"],
  [/\bHoudini\b/gi, "フーディーニ"],
  [/\bSideFX\b/gi, "サイドエフエックス"],
  [/\bURP\b/g, "ユーアールピー"],
  [/\bHDRP\b/g, "エイチディーアールピー"],
  [/\bSRP\b/g, "エスアールピー"],
  [/\bPCG\b/g, "ピーシージー"],
  [/\bGPU\b/g, "ジーピーユー"],
  [/\bCPU\b/g, "シーピーユー"],
  [/\bAPI\b/g, "エーピーアイ"],
  [/\bSDK\b/g, "エスディーケー"],
  [/\bCLI\b/g, "シーエルアイ"],
  [/\bLLM\b/g, "エルエルエム"],
  [/\bRAG\b/g, "ラグ"],
  [/\bMCP\b/g, "エムシーピー"],
  [/\bAI\b/g, "エーアイ"],
  [/\bDCC\b/g, "ディーシーシー"],
  [/\bVFX\b/g, "ブイエフエックス"],
  [/\bCEDEC\b/g, "セデック"],
  [/\bGDC\b/g, "ジーディーシー"],
  [/\bCloudflare\b/gi, "クラウドフレア"],
  [/\bGitHub\b/gi, "ギットハブ"],
  [/\bHugging ?Face\b/gi, "ハギングフェイス"],
  [/\barXiv\b/gi, "アーカイブ"],
  [/\bQiita\b/gi, "キータ"],
  [/\bZenn\b/gi, "ゼン"],
  [/\bWorkers\b/g, "ワーカーズ"],
  [/\bWebGPU\b/g, "ウェブジーピーユー"],
  [/\bGLSL\b/g, "ジーエルエスエル"],
  [/\bHLSL\b/g, "エイチエルエスエル"],
];

/** 読み上げ用に整える。URL・絵文字・記号を取り除き、日付と用語を読みにする。 */
export function normalizeForSpeech(text) {
  let s = String(text ?? "");
  s = s.replace(/https?:\/\/\S+/g, "");
  s = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "");
  s = s.replace(/(\d{4})-(\d{2})-(\d{2})/g, (_m, y, mo, d) => `${y}年${Number(mo)}月${Number(d)}日`);
  for (const [re, to] of READINGS) s = s.replace(re, to);
  s = s.replace(/[<>*_`#|~^[\]{}]/g, " ");
  s = s.replace(/\s*[/\\]\s*/g, "、");
  s = s.replace(/…|\.{3,}/g, "");
  s = s.replace(/\s+/g, " ");
  return s.trim();
}

export function greeting(hour) {
  if (hour >= 4 && hour < 11) return "おはようございます";
  if (hour >= 11 && hour < 18) return "こんにちは";
  return "こんばんは";
}

/** "2026-10-12" → "10月12日" */
export function spokenDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ""));
  return m ? `${Number(m[2])}月${Number(m[3])}日` : String(ymd ?? "");
}

/** 最初の1文。長ければ max 字で切る。 */
export function firstSentence(text, max = 80) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  // 日本語の句点は直後に空白が無い。ASCII の . ! ? は、後ろが空白か末尾のときだけ文の終わりとみなす
  const m = /^(.+?(?:[。！？]|[.!?](?=\s|$)))/.exec(s);
  const one = m ? m[1] : s;
  return one.length > max ? one.slice(0, max - 1) : one;
}

/** 記事の題名を、読み上げ向けに整える(末尾の「…」・先頭末尾の空白)。 */
export function cleanTitle(title) {
  return String(title ?? "").replace(/(…|\.{3,})\s*$/, "").trim();
}

/** 1秒あたり約6.5字(ゆっくりめの日本語)。速度 rate 倍で短くなる。 */
export function estimateSeconds(text, rate = 1) {
  return Math.max(1, Math.round(String(text ?? "").length / (6.5 * (rate || 1))));
}

export function formatClock(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const LEAD = ["まず、", "続いて、", "さらに、", "そして、", "最後に、"];
const SHORT = {
  game_dev_tech: "ゲーム開発",
  graphics_research: "グラフィクス",
  software_engineering: "ソフトウェア工学",
};

const itemSentence = (it, lead, maxSum) => {
  const t = cleanTitle(it.title);
  const sum = firstSentence(it.summary, maxSum);
  // 要約が題名と同じ書き出しなら、繰り返さない
  const dup = sum && (sum.startsWith(t.slice(0, 12)) || t.startsWith(sum.slice(0, 12)));
  return `${lead}${t}。${sum && !dup ? `${sum}` : ""}`;
};

/**
 * @param {object} p
 * @param {string} p.date            放送の日付 YYYY-MM-DD
 * @param {number} p.hour            時(JST。あいさつに使う)
 * @param {number} p.total           新着の総数(URL単位)
 * @param {Array}  p.highlights      注目の記事 [{title, summary}]
 * @param {Array}  p.lanes           [{id, label, count, items:[{title, summary}]}]  表示順
 * @param {number} [p.perCorner=4]   コーナーごとに読む記事数
 * @returns {{title: string, corners: Array<{id, label, kind, text, speech, jingle, seconds}>, totalSeconds: number}}
 */
export function buildRadioProgram({ date, hour = 12, total, highlights = [], lanes = [], perCorner = 4 }) {
  const corners = [];
  const live = lanes.filter((l) => l.count > 0);

  const breakdown = live
    .map((l) => `${SHORT[l.id] ?? l.label}が${l.count}件`)
    .join("、");
  corners.push({
    id: "open",
    kind: "open",
    label: "オープニング",
    jingle: "open",
    text:
      `${greeting(hour)}。リサーチブロードキャスト、${spokenDate(date)}の放送です。` +
      (total > 0 ? `今日の新着は、全部で${total}件。${breakdown ? `内訳は、${breakdown}です。` : ""}` : "今日は、新着がありません。") +
      (highlights.length ? "それでは、まず注目のニュースから。" : ""),
  });

  if (highlights.length) {
    corners.push({
      id: "headlines",
      kind: "headlines",
      label: "注目ニュース",
      jingle: "corner",
      text:
        "注目のニュースです。" +
        highlights
          .slice(0, 3)
          .map((it, i) => itemSentence(it, `${i + 1}本目。`, 70))
          .join(" "),
    });
  }

  for (const l of live) {
    const name = SHORT[l.id] ?? l.label;
    const shown = l.items.slice(0, perCorner);
    const rest = l.count - shown.length;
    corners.push({
      id: l.id,
      kind: "category",
      label: l.label,
      jingle: "corner",
      text:
        `${name}のコーナーです。新着は${l.count}件。` +
        shown.map((it, i) => itemSentence(it, LEAD[Math.min(i, LEAD.length - 1)], 60)).join(" ") +
        (rest > 0 ? ` ほか${rest}件は、サイトでご覧ください。` : ""),
    });
  }

  corners.push({
    id: "close",
    kind: "close",
    label: "エンディング",
    jingle: "close",
    text: `以上、${spokenDate(date)}の放送をお届けしました。記事の詳しい内容は、サイトの各カテゴリページでどうぞ。それでは、また次の放送で。`,
  });

  for (const c of corners) {
    c.speech = normalizeForSpeech(c.text);
    c.seconds = estimateSeconds(c.speech);
  }
  return {
    title: `${date} の放送`,
    corners,
    totalSeconds: corners.reduce((n, c) => n + c.seconds, 0),
  };
}

// ------------------------------------------------------------------ 読み上げの単位

/** 文末(。!?改行)で区切り、約 CHUNK_MAX 字ごとにまとめる。長い1文は読点・字数で割る。 */
export function splitChunks(text, max = 140) {
  // 文末の記号で区切る(後読みの正規表現は、古い Safari で構文エラーになるため使わない)
  const sentences = (String(text ?? "").replace(/\s+/g, " ").match(/[^。！？!?]+[。！？!?]?/g) ?? [])
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
