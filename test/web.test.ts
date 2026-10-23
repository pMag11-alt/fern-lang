import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { check, SourceFile } from "../src/index.js";
import { highlight } from "../web/highlight.js";
import { decodeShare, encodeShare } from "../web/share.js";

describe("playground highlighter", () => {
  test("colours tokens by kind and keeps the text intact", () => {
    const code = 'fn greet(name) => print("hi ${name}") // say hi\nlet n = 1';
    const html = highlight(code);
    assert.match(html, /<span class="kw">fn<\/span> <span class="def">greet<\/span>/);
    assert.match(html, /<span class="builtin">print<\/span>/);
    assert.match(html, /<span class="interp">\$\{<\/span>/);
    assert.match(html, /<span class="comment">\/\/ say hi<\/span>/);
    assert.match(html, /<span class="num">1<\/span>/);
    const text = html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    assert.equal(text, code + "\n ");
  });

  test("escapes HTML so code can't inject markup", () => {
    const html = highlight('print("<img src=x onerror=alert(1)>")');
    assert.ok(!html.includes("<img"));
    assert.ok(html.includes("&lt;img"));
  });

  test("underlines the ranges of diagnostics", () => {
    const code = "print(cuont)";
    const { diagnostics } = check(new SourceFile("t", code));
    assert.match(highlight(code, diagnostics), /<span class="bad">cuont<\/span>/);
  });
});

describe("share links", () => {
  test("round-trip any program, including non-ASCII text", () => {
    const code = 'let greeting = "héllo 🌿"\nprint(greeting)';
    const encoded = encodeShare(code);
    assert.match(encoded, /^[A-Za-z0-9_-]+$/, "URL-safe characters only");
    assert.equal(decodeShare("#code=" + encoded), code);
  });

  test("ignore fragments that are not share links or are damaged", () => {
    assert.equal(decodeShare(""), null);
    assert.equal(decodeShare("#section"), null);
    assert.equal(decodeShare("#code=%%%"), null);
    assert.equal(decodeShare("#code=_w"), null, "invalid UTF-8");
  });
});
