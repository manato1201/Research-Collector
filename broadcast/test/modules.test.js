// サイトの ES モジュールの、import と export の整合を静的に確かめる(ブラウザを使わない)。
// 「./x.js が export していない名前を import している」と、ブラウザでは、そのページだけでなくサイト全体が
// 動かなくなる(モジュールの読み込みが失敗する)ため、ここで先に落とす。
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const files = readdirSync(PUBLIC).filter(
  (f) => f.endsWith(".js") && f !== "theme-init.js" && f !== "sw.js",
);
const source = Object.fromEntries(
  files.map((f) => [f, readFileSync(join(PUBLIC, f), "utf8")]),
);

function exportsOf(text) {
  const names = new Set();
  for (const m of text.matchAll(
    /^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm,
  ))
    names.add(m[1]);
  for (const m of text.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop();
      if (name) names.add(name);
    }
  }
  return names;
}

test("every named import resolves to an export of the imported module", () => {
  const problems = [];
  for (const [file, text] of Object.entries(source)) {
    for (const m of text.matchAll(
      /^import\s*\{([^}]*)\}\s*from\s*"\.\/([\w.-]+)";/gm,
    )) {
      const target = m[2];
      if (!source[target]) {
        problems.push(`${file}: imports a missing file ${target}`);
        continue;
      }
      const have = exportsOf(source[target]);
      for (const raw of m[1].split(",")) {
        const name = raw.trim().split(/\s+as\s+/)[0];
        if (name && !have.has(name))
          problems.push(`${file}: "${name}" is not exported by ${target}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("every page module registered in app.js is imported from a file that exists", () => {
  const app = source["app.js"];
  for (const m of app.matchAll(/from\s*"\.\/([\w.-]+)"/g))
    assert.ok(source[m[1]], `app.js imports ${m[1]}`);
});

test("modules do not import each other in a cycle (except through app.js)", () => {
  const graph = {};
  for (const [file, text] of Object.entries(source)) {
    graph[file] = [...text.matchAll(/from\s*"\.\/([\w.-]+)"/g)]
      .map((m) => m[1])
      .filter((d) => source[d]);
  }
  const visiting = new Set();
  const done = new Set();
  const cycles = [];
  const visit = (f, path) => {
    if (done.has(f)) return;
    if (visiting.has(f)) {
      cycles.push([...path, f].join(" -> "));
      return;
    }
    visiting.add(f);
    for (const d of graph[f] ?? []) visit(d, [...path, f]);
    visiting.delete(f);
    done.add(f);
  };
  for (const f of Object.keys(graph)) visit(f, []);
  assert.deepEqual(cycles, []);
});
