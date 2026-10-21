// ラジオ原稿の生成(規則ベース。AI は使わない。DOM に依存しないので node でテストできる)
//
// 入力: その日の episode(件数・注目・カテゴリ別の記事)。出力: 番組(コーナーの並び)。
// 構成: オープニング(見どころの先出し)→ 注目ニュース → 今日のおすすめ → カテゴリ別のコーナー → 今日の用語ひとこと → 今日のおさらい → エンディング。
// 日本語ベース: 英語の題名は読まず、日本語の見出し(AI)か解説を使う。初めて聞く人向けに、カテゴリの紹介・用語の説明・おさらいを入れる。
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

/** 英語の語 → 読み(カタカナ)。日本語の声が読み誤りやすい、よく出る語だけ。 */
export const WORD_READINGS = [
  [/\bKarma\b/g, "カルマ"],
  [/\bLumen\b/g, "ルーメン"],
  [/\bNanite\b/g, "ナナイト"],
  [/\bEmbree\b/g, "エンブリー"],
  [/\bPrefab\b/gi, "プレハブ"],
  [/\bCursor\b/g, "カーソル"],
  [/\bPowerShell\b/gi, "パワーシェル"],
  [/\bFortnite\b/gi, "フォートナイト"],
  [/\bEpic\b/g, "エピック"],
  [/\bNVIDIA\b/g, "エヌビディア"],
  [/\bOpenAI\b/g, "オープンエーアイ"],
  [/\bAnthropic\b/g, "アンソロピック"],
];

/** アルファベット1字の読み(略語を1字ずつ読ませる)。 */
const LETTER = {
  A: "エー", B: "ビー", C: "シー", D: "ディー", E: "イー", F: "エフ", G: "ジー", H: "エイチ", I: "アイ",
  J: "ジェー", K: "ケー", L: "エル", M: "エム", N: "エヌ", O: "オー", P: "ピー", Q: "キュー", R: "アール",
  S: "エス", T: "ティー", U: "ユー", V: "ブイ", W: "ダブリュー", X: "エックス", Y: "ワイ", Z: "ゼット",
};

/** 4文字以上で、1字ずつ読ませる略語(HILL や SILENT のような、ふつうの英単語を誤って読まないよう、既知のものだけ)。 */
const LONG_ACRONYMS = new Set(["UEFN", "SASE", "WASM", "CUDA"]);

/** 辞書に無い大文字の略語(3字以下。XPU・SOP・DNS など)を、1字ずつの読みにする。 */
const spellAcronyms = (s) =>
  s.replace(/\b([A-Z]{2,5})(\d?)\b/g, (m, letters, digit) =>
    letters.length <= 3 || LONG_ACRONYMS.has(letters) ? [...letters].map((c) => LETTER[c]).join("") + digit : m,
  );

/** 読み上げ用に整える。URL・絵文字・記号を取り除き、日付・数字・用語を耳で聞いて分かる形にする。 */
export function normalizeForSpeech(text) {
  let s = String(text ?? "");
  s = s.replace(/https?:\/\/\S+/g, "");
  s = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "");
  s = s.replace(/(\d{4})-(\d{2})-(\d{2})/g, (_m, y, mo, d) => `${y}年${Number(mo)}月${Number(d)}日`);
  // ビルド番号(22.0.474 のような3つ以上の数字の並び)は、耳で聞いても意味が伝わらないので読まない
  s = s.replace(/\b\d+(?:\.\d+){2,}\b/g, "");
  // 3桁区切りのカンマ(50,000)は外す。読み上げが「50 0」と区切ることがあるため
  s = s.replace(/(\d),(?=\d{3}\b)/g, "$1");
  s = s.replace(/\b3D\b/g, "スリーディー").replace(/\b2D\b/g, "ツーディー");
  for (const [re, to] of READINGS) s = s.replace(re, to);
  for (const [re, to] of WORD_READINGS) s = s.replace(re, to);
  s = spellAcronyms(s);
  s = s.replace(/[<>*_`#|~^[\]{}]/g, " ");
  s = s.replace(/\s*[/\\]\s*/g, "、");
  s = s.replace(/…|\.{3,}/g, "");
  s = s.replace(/\s+/g, " ");
  // 日本語どうしの間の余計な空白は詰める(用語を読みに置き換えたあとに残る)
  s = s.replace(/([぀-ヿ一-鿿]) +(?=[぀-ヿ一-鿿])/g, "$1");
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
  if (one.length <= max) return one;
  // 長いときは、語の途中で切らない(空白・読点で、後半の範囲に切れ目があればそこで切る)
  const head = one.slice(0, max);
  const cut = Math.max(head.lastIndexOf(" "), head.lastIndexOf("、"), head.lastIndexOf(","));
  return cut >= max * 0.5 ? head.slice(0, cut).trim() : head.slice(0, max - 1);
}

/** 記事の題名を、読み上げ向けに整える(末尾の「…」・先頭末尾の空白)。 */
export function cleanTitle(title) {
  const t = String(title ?? "").trim();
  const m = /(…|\.{3,})\s*$/.exec(t);
  if (!m) return t;
  // 「…」で切れている題名(フィードが40字で切る)は、語の途中の残りを落とす
  const head = t.slice(0, m.index).trimEnd();
  if (head.length < 36) return head; // 短いものは、題名の側で省略した「…」。語は欠けていない
  const cut = head.lastIndexOf(" ");
  return (cut >= head.length * 0.5 ? head.slice(0, cut) : head).trim();
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
// コーナーの冒頭で、そのカテゴリが「どんな話題か」を一言で伝える(初めて聞く人向け)。追加分野など、定義が無いものは付けない
const CATEGORY_INTRO = {
  game_dev_tech: "ゲームづくりや、ゲームエンジンの技術に関する話題です。",
  graphics_research: "絵づくり、つまり描画や映像表現に関する話題です。",
  software_engineering: "プログラムの作り方や、AI・研究論文に関する話題です。",
};

const hasJapanese = (s) => /[぀-ヿ一-鿿]/.test(String(s ?? ""));

const endSentence = (s) => {
  const t = String(s ?? "").trim().replace(/[。.!！?？]+$/, "");
  return t ? `${t}。` : "";
};

/**
 * 読み上げに使う題名(日本語ベース)。題名が日本語ならそれ。英語の題名は、日本語の見出し(AI)があればそれを使う。
 * どちらも無ければ空文字(英語の題名は、日本語の音声では聞き取れないので、読まない)。
 */
export function displayTitle(it, ins = null) {
  const t = cleanTitle(it.title);
  if (hasJapanese(t)) return t;
  const ja = ins?.title_ja ? cleanTitle(ins.title_ja) : "";
  return hasJapanese(ja) ? ja : "";
}

/**
 * 見どころ・おさらいで列挙する題名。max 字に収まるものだけ使う(途中で切ると意味が変わるので、切らない。長い題名は、列挙では使わない)。
 */
export function fitTitle(title, max = 34) {
  const t = String(title ?? "").trim();
  return t && t.length <= max ? t : "";
}

/** 耳で聞いて意味が伝わる記事か。日本語の題名か要約、または AI の解説があるもの。英語だけの記事は、読まない。 */
const sayable = (it, ins) => Boolean(ins?.source === "ai" || displayTitle(it, ins) || hasJapanese(it.summary));

/** 概要が題名と同じ書き出し(同じ主語)なら、題名を重ねて読まない。耳で同じ語が続くと、くどく聞こえるため。 */
const repeatsTitle = (title, what) => Boolean(title && what && String(what).includes(title.slice(0, Math.min(8, title.length))));

const itemSentence = (it, lead, maxSum, ins = null, { withUse = true } = {}) => {
  const title = displayTitle(it, ins);
  if (ins && ins.source === "ai" && ins.what) {
    const head = repeatsTitle(title, ins.what) ? "" : endSentence(title);
    // 「何が分かるか」は、注目ニュースだけで読む。全部で読むと、「〜が分かります」が続いて単調になる
    return `${lead}${head}${endSentence(ins.what)}${withUse ? endSentence(ins.use) : ""}`;
  }
  const t = cleanTitle(it.title);
  const sum = firstSentence(it.summary, maxSum);
  // 要約が題名と同じ書き出しなら、繰り返さない。英語だけの要約は、日本語の音声では聞き取りにくいので読まない
  const dup = sum && (sum.startsWith(t.slice(0, 12)) || t.startsWith(sum.slice(0, 12)));
  const readable = sum && hasJapanese(sum);
  return `${lead}${endSentence(title)}${readable && !dup ? endSentence(sum) : ""}`;
};

/**
 * 「今日のおすすめ」のコーナーの原稿(広告風の紹介: 何か → 読むと何ができるか → どう応用できるか)。
 * @param {{title: string, title_ja?: string, what: string, use: string, apply: string, projects?: string[]}} rec
 */
export function recommendText(rec) {
  const title = hasJapanese(rec.title) ? cleanTitle(rec.title) : hasJapanese(rec.title_ja) ? cleanTitle(rec.title_ja) : "";
  const lines = [
    "ここで、今日のおすすめをご紹介します。",
    // 英語の題名は、聞き取りにくいので読まない(日本語の見出しか、解説を主にする)
    endSentence(title),
    endSentence(rec.what),
    rec.use ? `この記事を読むと、${endSentence(rec.use)}` : "",
    rec.apply ? `たとえば、${endSentence(rec.apply)}` : "",
    rec.projects?.length ? `${rec.projects.slice(0, 2).join("、")}に関係しそうです。` : "",
    "詳しくは、サイトの、今日のおすすめからどうぞ。",
  ];
  return lines.filter(Boolean).join(" ");
}

/** 出典の定型の解説(「X。Y です。」の形)を、話し言葉の「これは、X です。Y です。」にする。 */
function spokenSource(what) {
  const m = /^([^。]+)。(.+?)(?:です)?。?$/.exec(String(what ?? "").trim());
  return m ? `ちなみに、これは、${m[1]}です。${m[2]}です。` : `ちなみに、${endSentence(what)}`;
}

/**
 * @param {object} p
 * @param {string} p.date            放送の日付 YYYY-MM-DD
 * @param {number} p.hour            時(JST。あいさつに使う)
 * @param {number} p.total           新着の総数(URL単位)
 * @param {Array}  p.highlights      注目の記事 [{url_hash, title, summary, platform}]
 * @param {Array}  p.lanes           [{id, label, count, items:[{url_hash, title, summary, platform}]}]  表示順
 * @param {number} [p.perCorner=4]   コーナーごとに読む記事数(解説があるときは3本まで)
 * @param {object} [p.insights]      {url_hash: {title_ja, what, use, apply, term, term_meaning, source: "ai"|"rule"}}(worker の /api/insights)
 * @param {object} [p.recommend]     今日のおすすめ {title, title_ja, what, use, apply, projects}。あればコーナーにする
 * @returns {{title: string, corners: Array<{id, label, kind, text, speech, jingle, seconds}>, totalSeconds: number}}
 */
export function buildRadioProgram({
  date, hour = 12, total, highlights = [], lanes = [], perCorner = 4, insights = {}, recommend = null,
}) {
  const corners = [];
  const live = lanes.filter((l) => l.count > 0);
  const per = Object.keys(insights).length ? Math.min(perCorner, 3) : perCorner;
  const explained = new Set(); // 出典の紹介は、番組の中で1回だけ
  const spoken = new Set(); // 同じ記事を、別のコーナーでもう一度読まない(複数カテゴリの記事)
  const spokenItems = []; // 読んだ記事(おさらい・用語に使う)。読んだ順
  const keyOf = (it) => it.url_hash ?? it.url ?? it.title;

  /** 解説(AI)のある記事を先に、すでに読んだ記事は除いて、n本を選ぶ。 */
  const choose = (items, n) => {
    // 読めない記事(英語だけで、日本語の見出しも解説も無い)は、選ばない
    const fresh = items.filter((it) => !spoken.has(keyOf(it)) && sayable(it, insights[it.url_hash]));
    // 優先: ① AI の解説がある ② 日本語の題名・要約・見出しだけ
    const rank = (it) => (insights[it.url_hash]?.source === "ai" ? 0 : 1);
    const picked = fresh
      .map((it, i) => ({ it, i, r: rank(it) }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .slice(0, n)
      .map((x) => x.it);
    picked.forEach((it) => {
      spoken.add(keyOf(it));
      spokenItems.push(it);
    });
    return picked;
  };

  // 解説が無い記事の出典を、最初の1回だけ「これは何の情報か」として紹介する
  const sourceNote = (it) => {
    const ins = insights[it.url_hash];
    if (!it.platform || explained.has(it.platform) || (ins && ins.source === "ai")) return "";
    const rule = ins && ins.source === "rule" ? ins : null;
    if (!rule) return "";
    explained.add(it.platform);
    return ` ${spokenSource(rule.what)}`;
  };
  const sentence = (it, lead, maxSum, opts) => itemSentence(it, lead, maxSum, insights[it.url_hash], opts) + sourceNote(it);

  // 注目ニュースは先に選んでおく(オープニングで見どころを先出しするため。実際に読む記事と一致させる)
  const headlineItems = highlights.length ? choose(highlights, 3) : [];
  const previewTitles = headlineItems
    .map((it) => fitTitle(displayTitle(it, insights[it.url_hash]), 34))
    .filter(Boolean)
    .slice(0, 2);

  corners.push({
    id: "open",
    kind: "open",
    label: "オープニング",
    jingle: "open",
    text:
      `${greeting(hour)}。リサーチブロードキャスト、${spokenDate(date)}の放送です。` +
      "ゲーム開発やグラフィクスの新しい情報を、やさしくご紹介する番組です。" +
      (total > 0 ? `今日の新着は、全部で${total}件。その中から、気になる話題をお伝えします。` : "今日は、新着がありません。") +
      // 見どころは、短い文に分けて言う(題名を1文に並べると、耳では追えない長さになる)
      (previewTitles.length ? `今日の注目は、「${previewTitles[0]}」。${previewTitles[1] ? `それから、「${previewTitles[1]}」。` : ""}` : "") +
      (headlineItems.length ? "それでは、まず注目のニュースから。" : ""),
  });

  if (headlineItems.length) {
    corners.push({
      id: "headlines",
      kind: "headlines",
      label: "注目ニュース",
      jingle: "corner",
      text: "注目のニュースです。" + headlineItems.map((it, i) => sentence(it, `${i + 1}本目。`, 70)).join(" "),
    });
  }

  if (recommend) {
    corners.push({
      id: "recommend",
      kind: "recommend",
      label: "今日のおすすめ",
      jingle: "corner",
      text: recommendText(recommend),
    });
  }

  for (const l of live) {
    const name = SHORT[l.id] ?? l.label;
    const shown = choose(l.items, per);
    if (!shown.length) {
      // 読める記事が無い。他のコーナーで読み終わっている場合は飛ばす。英語の記事が中心のときは、そのことだけを短く伝える
      if (l.items.some((it) => !spoken.has(keyOf(it)))) {
        corners.push({
          id: l.id,
          kind: "category",
          label: l.label,
          jingle: "corner",
          text: `${name}のコーナーです。新着は${l.count}件ですが、英語の記事が中心です。詳しくは、サイトでご覧ください。`,
        });
      }
      continue;
    }
    const rest = l.count - shown.length;
    corners.push({
      id: l.id,
      kind: "category",
      label: l.label,
      jingle: "corner",
      text:
        `${name}のコーナーです。${CATEGORY_INTRO[l.id] ?? ""}新着は${l.count}件。` +
        shown.map((it, i) => sentence(it, LEAD[Math.min(i, LEAD.length - 1)], 60, { withUse: false })).join(" ") +
        (rest > 0 ? ` ほかにも、${rest}件あります。` : ""),
    });
  }

  // 今日の用語ひとこと: 読んだ記事に出てきた用語のうち、説明のあるものを最大2つ(AI がまとめた説明であることを伝える)
  const terms = [];
  for (const it of spokenItems) {
    const ins = insights[it.url_hash];
    if (ins?.source === "ai" && ins.term && ins.term_meaning && !terms.some((t) => t.term === ins.term)) {
      terms.push({ term: ins.term, meaning: ins.term_meaning });
    }
    if (terms.length >= 2) break;
  }
  if (terms.length) {
    corners.push({
      id: "glossary",
      kind: "glossary",
      label: "今日の用語ひとこと",
      jingle: "corner",
      text:
        "今日の用語ひとことです。ここまでに出てきた言葉を、AIがやさしくまとめました。" +
        terms.map((t, i) => `${i === 0 ? "まず" : "もうひとつ"}、${t.term}。${endSentence(t.meaning)}`).join(" "),
    });
  }

  // 今日のおさらい: 耳で聞くと振り返れないので、読んだ話題を最後にもう一度まとめる
  const recapTitles = spokenItems
    .map((it) => fitTitle(displayTitle(it, insights[it.url_hash]), 34))
    .filter(Boolean)
    .slice(0, 3);
  if (recapTitles.length >= 2) {
    corners.push({
      id: "recap",
      kind: "recap",
      label: "今日のおさらい",
      jingle: "corner",
      text:
        `今日のおさらいです。${recapTitles.map((t) => `「${t}」。`).join("")}以上を、お伝えしました。` +
        "気になった話題は、サイトのボードに入れておくと、あとで読み返せます。",
    });
  }

  corners.push({
    id: "close",
    kind: "close",
    label: "エンディング",
    jingle: "close",
    text: `以上、${spokenDate(date)}の放送をお届けしました。記事の詳しい内容は、サイトでご覧いただけます。それでは、また次の放送で。`,
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
