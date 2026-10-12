// 週次レポート(NotebookLM が作った Markdown)を、安全に描画・読み上げ用の平文にする小さな変換器。
//
// 方針: HTML 文字列は作らない。DOM ノードを作って textContent だけを入れる(XSS の余地を作らない)。
//  - リンクは http(s) だけ(javascript: などは、リンクにせず文字のまま出す)。
//  - 画像は出さない(外部への読み込みをしない。CSP も img-src 'self' data: のみ)。
//  - 対応: 見出し(# 〜 ######)・段落・箇条書き(- * + / 1.)・引用(>)・コード(``` と `)・
//          罫線(---)・表(| a | b |)・太字(**)・斜体(*)・リンク([文字](URL))・URL の自動リンク。

const MAX_NODES = 6000; // 異常に大きな入力でページが固まらないように

function safeUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === "https:" || x.protocol === "http:" ? x.href : null;
  } catch {
    return null;
  }
}

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) e.setAttribute(k, v);
  for (const k of kids)
    e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}

function link(text, href) {
  const a = el(
    "a",
    { href, target: "_blank", rel: "noopener noreferrer" },
    text,
  );
  return a;
}

// インライン: `code` / **bold** / *italic* / [text](url) / 素のURL
const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))|(https?:\/\/[^\s<>()[\]]+)|(\*[^*\n]+\*)/g;

export function renderInline(text) {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last)
      frag.append(document.createTextNode(text.slice(last, m.index)));
    const tok = m[0];
    if (m[1]) {
      frag.append(el("code", null, tok.slice(1, -1)));
    } else if (m[2]) {
      frag.append(el("strong", null, renderInline(tok.slice(2, -2))));
    } else if (m[3]) {
      const mm = /^\[([^\]]+)\]\((.+)\)$/.exec(tok);
      const href = mm ? safeUrl(mm[2]) : null;
      frag.append(href ? link(mm[1], href) : document.createTextNode(tok));
    } else if (m[4]) {
      // 文末の句読点・閉じ括弧は URL に含めない
      const core = tok.replace(/[、。,.;:!?」』）]+$/, "");
      const href = safeUrl(core);
      frag.append(href ? link(core, href) : document.createTextNode(core));
      if (core.length < tok.length) frag.append(document.createTextNode(tok.slice(core.length)));
    } else if (m[5]) {
      frag.append(el("em", null, tok.slice(1, -1)));
    }
    last = m.index + tok.length;
  }
  if (last < text.length)
    frag.append(document.createTextNode(text.slice(last)));
  return frag;
}

const isTableSep = (l) =>
  /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const splitRow = (l) =>
  l
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

/**
 * Markdown → DocumentFragment。
 * baseLevel: `#` を何番目の見出しにするか(ページ側が h1/h2 を使うので、既定は h3 から)。
 */
export function renderMarkdown(src, { baseLevel = 3 } = {}) {
  const root = document.createDocumentFragment();
  const lines = String(src ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  let nodes = 0;
  let i = 0;

  const push = (n) => {
    if (nodes++ < MAX_NODES) root.append(n);
  };

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    // コードブロック
    if (/^\s*```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]))
        buf.push(lines[i++]);
      i++;
      push(el("pre", null, el("code", null, buf.join("\n"))));
      continue;
    }

    // 見出し
    const hm = /^(#{1,6})\s+(.*)$/.exec(line);
    if (hm) {
      const level = Math.min(6, baseLevel + hm[1].length - 1);
      push(el(`h${level}`, { class: "md-h" }, renderInline(hm[2].trim())));
      i++;
      continue;
    }

    // 罫線
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      push(el("hr"));
      i++;
      continue;
    }

    // 表
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      isTableSep(lines[i + 1])
    ) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (
        i < lines.length &&
        lines[i].includes("|") &&
        !/^\s*$/.test(lines[i])
      )
        rows.push(splitRow(lines[i++]));
      const table = el(
        "table",
        { class: "md-table" },
        el(
          "thead",
          null,
          el("tr", null, ...head.map((c) => el("th", null, renderInline(c)))),
        ),
        el(
          "tbody",
          null,
          ...rows.map((r) =>
            el("tr", null, ...r.map((c) => el("td", null, renderInline(c)))),
          ),
        ),
      );
      push(el("div", { class: "md-table-wrap" }, table));
      continue;
    }

    // 引用
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i]))
        buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      push(el("blockquote", null, renderInline(buf.join(" "))));
      continue;
    }

    // 箇条書き(インデントの深さは2段まで見る)
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const list = el(ordered ? "ol" : "ul", null);
      let parent = list;
      let lastLi = null;
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        const depth = Math.min(1, Math.floor(m[1].length / 2));
        const li = el("li", null, renderInline(m[3]));
        if (depth === 1 && lastLi) {
          let sub = lastLi.querySelector(":scope > ul");
          if (!sub) {
            sub = el("ul", null);
            lastLi.append(sub);
          }
          sub.append(li);
        } else {
          parent.append(li);
          lastLi = li;
        }
        i++;
        nodes++;
      }
      push(list);
      continue;
    }

    // 段落(空行・別の構文が来るまでをまとめる)
    const buf = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*```/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])
    ) {
      buf.push(lines[i++].trim());
    }
    push(el("p", null, renderInline(buf.join(" "))));
  }
  return root;
}

/** 読み上げ用の平文(記号・URL を取り除く)。 */
export function markdownToSpeech(src) {
  return String(src ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s*\|?\s*:?-{2,}[-|:\s]*$/gm, "")
    .replace(/[*_|]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
