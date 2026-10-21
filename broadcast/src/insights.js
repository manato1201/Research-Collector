// 記事の「解説」(これは何か / 何ができるか / どう応用できるか)の生成と検証
//
// 生成: Workers AI(無料枠。1日 10,000 Neurons)。入力は、題名・要約・出典の性格・カテゴリ・読み手の関心(関連プロジェクト)。
// **根拠にするのは、題名と要約だけ**(本文は取らない)。書かれていないことを断定させない指示と、出力の検証で、作り話を減らす。
// AI が使えない・失敗したときは、出典の種類ごとの定型の解説(規則ベース。source = "rule")で補う。
// 解説は「AI が題名と要約から書いたもの」として、サイトに明示する(誤りを含みうる)。
//
// DOM・D1・ネットワークに依存しない純粋な関数だけ(node でテストできる)。

/** 出典(platform)ごとの、性格と使いどころ。AI への入力にも、規則ベースの解説にも使う。 */
export const SOURCE_INFO = {
  sidefx_changelog: {
    name: "SideFX(Houdini)の変更履歴",
    what: "Houdini のビルドごとの、修正・新機能の記録",
    use: "いま使っているバージョンに効く修正や新機能を、短時間で確認できます",
    apply: "アップデートするかの判断や、既知の不具合の回避策探しに使えます",
  },
  cloudflare_changelog: {
    name: "Cloudflare の変更履歴",
    what: "Workers・D1・R2 などのサービスの、仕様変更や新機能の記録",
    use: "制限や挙動の変更を、障害になる前に知ることができます",
    apply: "自分のサイトや Worker の設定・互換性日付の見直しに使えます",
  },
  huggingface_blog: {
    name: "Hugging Face ブログ",
    what: "公開された AI モデルや手法の紹介記事",
    use: "使えるモデルやライブラリを、早めに見つけられます",
    apply: "プロジェクトのモデル選定や、RAG・エージェント構成の検討に使えます",
  },
  unity_blog: {
    name: "Unity 公式ブログ",
    what: "Unity の新機能・事例・技術解説",
    use: "公式の方針と、推奨される作り方が分かります",
    apply: "プロジェクトのバージョン方針や、描画・ツール設計の見直しに使えます",
  },
  ue_blog: {
    name: "Unreal Engine 公式ブログ",
    what: "Unreal Engine の新機能・事例・技術解説",
    use: "公式の方針と、推奨される作り方が分かります",
    apply: "プロジェクトのバージョン方針や、PCG・描画の設計の見直しに使えます",
  },
  zenn: {
    name: "Zenn の技術記事",
    what: "個人の開発者による、実装や調査の記事",
    use: "実際に試した人の手順や、つまずきどころが分かります",
    apply: "自分のプロジェクトに近い部分を、そのまま試す足がかりにできます",
  },
  qiita: {
    name: "Qiita の技術記事",
    what: "個人の開発者による、実装や調査の記事",
    use: "実際に試した人の手順や、つまずきどころが分かります",
    apply: "自分のプロジェクトに近い部分を、そのまま試す足がかりにできます",
  },
  arxiv: {
    name: "arXiv の論文",
    what: "査読前を含む、研究論文のプレプリント",
    use: "新しい手法や評価の結果を、一次情報として確認できます",
    apply: "手法の着想や、自分の提案の根拠・関連研究の整理に使えます",
  },
  semantic_scholar: {
    name: "Semantic Scholar の論文",
    what: "公開された研究論文",
    use: "関連分野の研究の動向を、まとめて把握できます",
    apply: "関連研究の整理や、自分のテーマの位置づけの確認に使えます",
  },
  cedil: {
    name: "CEDiL(CEDEC の講演資料)",
    what: "ゲーム開発者会議の講演・資料",
    use: "現場の開発者が、何に取り組んでいるかが分かります",
    apply: "自分の制作フローや、チームの技術選定の参考になります",
  },
};

const DEFAULT_INFO = {
  name: "収集した記事",
  what: "技術に関する記事",
  use: "最新の動向を、短時間で確認できます",
  apply: "気になる部分を、自分のプロジェクトで試す足がかりにできます",
};

export function sourceInfo(platform) {
  return SOURCE_INFO[platform] ?? DEFAULT_INFO;
}

const CATEGORY_LABELS = {
  game_dev_tech: "ゲーム開発・エンジン技術",
  graphics_research: "グラフィクス・レンダリング",
  software_engineering: "ソフトウェア工学・論文",
};

export const INSIGHT_LIMITS = { title_ja: 50, what: 140, use: 110, apply: 120, term: 24, term_meaning: 90 };

/** 解説の版。2 = 初心者・聞き手向け(日本語の見出し・かんたんな概要・用語の説明)。古い版の行は、再生成の対象。 */
export const INSIGHT_VERSION = 2;

/**
 * 読み手のプロジェクトのうち、題名・要約・キーワードに、プロジェクトのキーワードが含まれるものだけ。
 * 関係の無い記事に、無理にプロジェクトを結びつけさせないために、AI へは「当てはまるもの」だけを渡す。
 */
export function relevantProjects(article, projects = []) {
  const hay = `${article.title ?? ""} ${article.summary ?? ""} ${(article.keywords ?? []).join(" ")}`.toLowerCase();
  return projects.filter((p) => (p.keywords ?? []).some((k) => k && hay.includes(String(k).toLowerCase())));
}

/** 要約が十分にあるか。題名だけの記事は、AI に書かせない(題名からの推測になり、作り話が混ざるため)。 */
export const MIN_SUMMARY_CHARS = 40;
export const hasBasis = (article) => String(article.summary ?? "").trim().length >= MIN_SUMMARY_CHARS;

/** AI への指示。1件の記事ごとに呼ぶ。noThink: Qwen3 の「考える」過程を切る(出力の長さを使い切らないように)。 */
export function buildMessages(article, { projects = [], noThink = false } = {}) {
  const info = sourceInfo(article.platform);
  const cats = (article.categories ?? []).map((c) => CATEGORY_LABELS[c]).filter(Boolean);
  const interests = relevantProjects(article, projects)
    .slice(0, 3)
    .map((p) => `${p.name}(${(p.keywords ?? []).slice(0, 6).join("、")})`)
    .join(" / ");

  const system = [
    "あなたは、ゲーム開発・グラフィクス・ソフトウェア工学の技術情報を、初心者にもやさしく紹介する、ラジオ番組の解説者です。",
    "聞き手は、耳だけで聞いています。専門知識の無い人にも「何の話か」「聞く価値があるか」が伝わるように書きます。",
    "与えられた1件の記事情報(題名・要約・出典)だけを根拠に、日本語で、次の項目を書きます。",
    "- title_ja: 題名の、自然な日本語の見出し(" + INSIGHT_LIMITS.title_ja + "字以内)。題名がすでに日本語ならそのまま。製品名・固有名詞は英字のままでよい。",
    "- what: 何についての話か。初心者向けに、専門用語は言い換えながら1〜2文(" + INSIGHT_LIMITS.what + "字以内)。",
    "- use: 読むと(聞くと)何が分かるか・何の役に立つか(1文。" + INSIGHT_LIMITS.use + "字以内)。",
    "- apply: 制作・開発にどう応用できるか。具体的な場面を1つ(1文。" + INSIGHT_LIMITS.apply + "字以内)。",
    "- term: 初心者がつまずきそうな専門用語を1つ(" + INSIGHT_LIMITS.term + "字以内)。無ければ空文字。",
    "- term_meaning: その用語の、やさしい説明(1文。" + INSIGHT_LIMITS.term_meaning + "字以内)。意味に自信が無い用語は、term ごと空文字にする。",
    "守ること:",
    "- what は、題名の言い換えや「〜の話です」だけで終わらせない。要約から分かる中身(何を作った・何が分かった・何が変わった)を、必ず1つ入れる。",
    "- 「わかりやすい内容です」「役に立ちます」だけの、中身の無い文は書かない。何がどう役に立つかを言う。",
    "- term は、題名・要約に出てくる言葉から選ぶ。",
    "- 耳で聞いて分かる、話し言葉の「です・ます」調で書く。1文は短く。「〜することが可能となっている」のような硬い言い方は使わない。",
    "- 題名・要約に書かれていないことを、事実として断定しない。書かれていない部分は「〜できそうです」「〜の場面で役立つ可能性があります」と控えめに言う。",
    "- 数字・バージョン・固有名詞は、題名・要約にあるものだけを使い、綴りを一字も変えずに写す。",
    "- 略語や製品名の正式名称を、自分の知識で補わない。題名・要約に書かれていない略語は、意味を説明せず、そのまま使う。",
    "- 誇張・宣伝文句・絵文字・URL・英語の文は使わない(固有名詞と技術用語は、英字のままでよい)。",
    "- 「読み手の関心」が「なし」でないときだけ、apply でそれに触れてよい。「なし」のときは、触れない。",
    '- 出力は JSON のみ: {"title_ja":"…","what":"…","use":"…","apply":"…","term":"…","term_meaning":"…"}',
  ].join("\n");

  const user = JSON.stringify(
    {
      題名: article.title,
      要約: article.summary || "なし(題名だけから、分かる範囲で書く)",
      出典: `${info.name}(${info.what})`,
      カテゴリ: cats,
      公開日: article.published ?? "不明",
      読み手の関心: interests || "なし",
    },
    null,
    1,
  );
  return [
    { role: "system", content: system },
    { role: "user", content: (noThink ? "/no_think\n" : "") + user },
  ];
}

const URL_RE = /https?:\/\/\S+/g;

function cleanField(v, max) {
  if (typeof v !== "string") return null;
  // 先頭の見出し記号(#・*・-・・)は、読み上げでも表示でも邪魔なので落とす
  let s = v.replace(URL_RE, "").replace(/\s+/g, " ").replace(/^[#*・\-\s]+/, "").trim();
  if (!s) return null;
  if (s.length > max) s = s.slice(0, max - 1).replace(/[、,\s]+$/, "") + "…";
  return s;
}

const JA_RE = /[぀-ヿ一-鿿]/;

/** モデルの出力から JSON のオブジェクトを取り出す(考える過程・コードフェンス・前後の文は無視)。 */
function extractJson(raw) {
  if (typeof raw !== "string") return null;
  // 「考える」過程(<think>…</think>)に含まれる { を拾わない
  const text = raw.replace(/<think>[\s\S]*?<\/think>/g, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * モデルの出力から、解説の項目を取り出す。what / use / apply が揃わない・日本語でないなら null(呼び出し側が規則ベースで補う)。
 * title_ja・用語は、無ければ null(あるものだけ使う。用語は、言葉と説明が揃ったときだけ)。
 * @returns {{title_ja: string|null, what: string, use: string, apply: string, term: string|null, term_meaning: string|null} | null}
 */
export function parseInsight(raw) {
  const obj = extractJson(raw);
  if (!obj) return null;
  const what = cleanField(obj.what, INSIGHT_LIMITS.what);
  const use = cleanField(obj.use, INSIGHT_LIMITS.use);
  const apply = cleanField(obj.apply, INSIGHT_LIMITS.apply);
  if (!what || !use || !apply) return null;
  // 英語だけの出力(日本語を指示している)は使わない
  if (![what, use, apply].every((s) => JA_RE.test(s))) return null;
  const titleJa = cleanField(obj.title_ja, INSIGHT_LIMITS.title_ja);
  const term = cleanField(obj.term, INSIGHT_LIMITS.term);
  const meaning = cleanField(obj.term_meaning, INSIGHT_LIMITS.term_meaning);
  const hasTerm = term && meaning && JA_RE.test(meaning);
  return {
    title_ja: titleJa && JA_RE.test(titleJa) ? titleJa : null,
    what,
    use,
    apply,
    term: hasTerm ? term : null,
    term_meaning: hasTerm ? meaning : null,
  };
}

/** 要約が無い(題名だけの)英語の記事に、日本語の見出しだけを付けさせる指示。題名の翻訳だけなので、作り話になりにくい。 */
export function buildTitleMessages(article, { noThink = false } = {}) {
  const system = [
    "あなたは、技術記事の題名を、自然な日本語の見出しにする翻訳者です。",
    "与えられた題名だけを、" + INSIGHT_LIMITS.title_ja + "字以内の日本語の見出しにします。",
    "守ること:",
    "- 題名に無い内容を足さない。製品名・固有名詞・バージョン番号は、綴りを一字も変えずに、英字のまま写す。",
    "- 絵文字・URL・説明文は付けない。",
    '- 出力は JSON のみ: {"title_ja":"…"}',
  ].join("\n");
  const user = JSON.stringify({ 題名: article.title }, null, 1);
  return [
    { role: "system", content: system },
    { role: "user", content: (noThink ? "/no_think\n" : "") + user },
  ];
}

/** @returns {string | null} 日本語の見出し。取れない・日本語を含まないなら null */
export function parseTitle(raw) {
  const t = cleanField(extractJson(raw)?.title_ja, INSIGHT_LIMITS.title_ja);
  return t && JA_RE.test(t) ? t : null;
}

/** AI が使えない・失敗したときの、出典の種類ごとの定型の解説。 */
export function fallbackInsight(article) {
  const info = sourceInfo(article.platform);
  return { what: `${info.name}。${info.what}です。`, use: `${info.use}。`, apply: `${info.apply}。` };
}

/** Workers AI の応答(モデルによって形が違う)から、本文の文字列を取り出す。 */
export function extractText(result) {
  if (result == null) return null;
  if (typeof result === "string") return result;
  if (typeof result.response === "string") return result.response;
  if (result.response && typeof result.response === "object") return JSON.stringify(result.response);
  const choice = result.choices?.[0];
  if (typeof choice?.message?.content === "string") return choice.message.content;
  if (typeof choice?.text === "string") return choice.text;
  return null;
}

/**
 * 日本語の見出しが、元の題名の綴りを崩していないか。見出しに含まれる英字の語(3字以上)が、すべて元の題名にもあること。
 * モデルが固有名詞を誤って写す(SILENT HILL → SILENT HIL など)と、音声でそのまま誤りを読み上げてしまうため。
 */
export function titleIsFaithful(titleJa, original) {
  const words = (t) => String(t ?? "").toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  const have = new Set(words(original));
  return words(titleJa).every((w) => have.has(w));
}
