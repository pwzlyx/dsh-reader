import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// client.js 是浏览器端的自注册 bundle：桩一个 __ModuleLoader__ 和最小 DOM，然后在 Node 里跑。
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "client.js"), "utf8");
const stubReact = {
  createElement: (type, props, ...kids) => ({ type, props, kids }),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useState: (value) => [value, () => {}],
};
let factory = null;
globalThis.window = { __ModuleLoader__: { load: (mod) => { factory = mod.factory; } } };
globalThis.document = {
  createElement: () => ({ setAttribute() {}, remove() {}, style: {}, textContent: "", appendChild() {} }),
  head: { appendChild() {} },
  addEventListener() {},
  querySelector: () => null,
};
new Function("window", source)(globalThis.window);
const mod = factory((name) => {
  if (name === "react") return stubReact;
  throw new Error("unexpected require: " + name);
});
const C = globalThis.__DSH_READER_CORE__;

test("bundle 注册了组件和 core", () => {
  assert.equal(typeof mod.apply, "function");
  assert.ok(C && typeof C.jsonFormat === "function");
  for (const name of ["sqlFormat", "parseMarkdown", "diffSeq", "buildHunks", "findRanges", "replaceAll", "guessKind"]) {
    assert.equal(typeof C[name], "function", name + " 应该是函数");
  }
});

test("JSON 格式化 / 排序 / 压缩", () => {
  const src = "{\"b\":1,\"a\":[1,2]}";
  assert.equal(C.jsonFormat(src, { indent: 2 }).text, "{\n  \"b\": 1,\n  \"a\": [\n    1,\n    2\n  ]\n}");
  assert.equal(C.jsonFormat(src, { indent: 2, sortKeys: true }).text.indexOf("\"a\"") < C.jsonFormat(src, { indent: 2, sortKeys: true }).text.indexOf("\"b\""), true);
  assert.equal(C.jsonFormat(src, { minify: true }).text, "{\"b\":1,\"a\":[1,2]}");
});

test("JSON 报错带行列定位", () => {
  const bad = C.jsonFormat("{\n  \"a\": 1,\n  \"b\": ,\n}", {});
  assert.equal(bad.ok, false);
  assert.equal(bad.spot.line, 3, "错误行要落在第 3 行");
  assert.equal(bad.spot.col, 8);
  assert.match(bad.spot.preview, /"b"/);
  const truncated = C.jsonFormat("{\"a\": [1, 2", {});
  assert.equal(truncated.ok, false);
  assert.equal(truncated.spot.line, 1);
  const trailing = C.jsonFormat("{\"a\": 1,}", {});
  assert.equal(trailing.ok, false);
  assert.ok(trailing.spot, "即使引擎不报 position，也要能定位");
});

test("SQL 子句换行、函数参数不拆行", () => {
  const out = C.sqlFormat("select u.id, count(*), sum(o.amount) total from orders o left join users u on u.id = o.uid where o.state = 1 and u.level in (1,2) group by u.id order by total desc limit 10;").text;
  assert.match(out, /^SELECT\n/u);
  assert.match(out, /\nFROM orders o\n/u);
  assert.match(out, /\nLEFT JOIN users u\n\s+ON u\.id = o\.uid\n/u);
  assert.match(out, /\nGROUP BY\n/u);
  assert.match(out, /\nLIMIT 10;/u);
  assert.match(out, /COUNT\(\*\)/u);
  assert.match(out, /SUM\(o\.amount\)/u);
});

test("Markdown 解析出块结构", () => {
  const blocks = C.parseMarkdown("# h1\n\npara **bold**\n\n- a\n- b\n\n| x | y |\n|---|:-:|\n| 1 | 2 |\n\n> quote");
  const types = blocks.map((block) => block.type);
  assert.deepEqual(types.slice(0, 3), ["heading", "para", "list"]);
  assert.ok(types.includes("table"));
  assert.ok(types.includes("quote"));
  const table = blocks.find((block) => block.type === "table");
  assert.deepEqual(table.align, ["", "center"], "没写对齐的列按默认处理");
});

test("行切分保留 CRLF 语义", () => {
  assert.deepEqual(C.splitLines("a\nb\n"), ["a", "b"]);
  assert.deepEqual(C.lineSpans("a\r\nb\r\n"), [[0, 1], [3, 4]]);
});

test("diff 与 hunk", () => {
  const ops = C.diffSeq(["a", "b", "c"], ["a", "x", "c", "d"]);
  assert.deepEqual(C.diffStats(ops), { added: 2, removed: 1 });
  const hunks = C.buildHunks(C.diffSeq(["1", "2", "3", "4", "5", "6", "7", "8", "9"], ["1", "2", "X", "4", "5", "6", "7", "8", "Y"]), 1);
  assert.ok(hunks.length >= 1);
  assert.equal(hunks[0].ops[0].op, "eq", "每个 hunk 前面都带上下文");
  const words = C.diffWords("const a = 1", "const b = 1");
  assert.deepEqual(words.a.map((seg) => seg.kind), ["same", "del", "same"]);
  assert.deepEqual(words.b.map((seg) => seg.kind), ["same", "ins", "same"]);
});

test("查找与替换", () => {
  const text = "name NAME name";
  assert.equal(C.findRanges(text, "name", false, false, 10).ranges.length, 3);
  assert.equal(C.findRanges(text, "name", true, false, 10).ranges.length, 2);
  assert.equal(C.findRanges("a1 b2", "\\d", false, true, 10).ranges.length, 2);
  const bad = C.findRanges("x", "(", false, true, 10);
  assert.ok(bad.error, "非法正则要报错");
  const one = C.replaceOne("a b", "b", "c", false, false, 0);
  assert.equal(one.text, "a c");
  const grouped = C.replaceOne("v1.2", "(\\d)\\.(\\d)", "$2_$1", false, true, 0);
  assert.equal(grouped.text, "v2_1");
  const all = C.replaceAll("x x x", "x", "y", false, false);
  assert.equal(all.text, "y y y");
  assert.equal(all.count, 3);
});

test("自动识别文件类型", () => {
  assert.equal(C.guessKind("a.json", ""), "json");
  assert.equal(C.guessKind("a.md", ""), "md");
  assert.equal(C.guessKind("a.sql", ""), "sql");
  assert.equal(C.guessKind("", "{\"a\":1}"), "json");
  assert.equal(C.guessKind("", "select a from t"), "sql");
  assert.equal(C.guessKind("", "hello"), "text");
});
