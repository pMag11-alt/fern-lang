import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { SourceFile, tokenize } from "../src/index.js";
import type { Token } from "../src/token.js";

function lex(code: string): Token[] {
  return tokenize(new SourceFile("test.fern", code)).tokens;
}

/** Token kinds, with inserted semicolons shown as "NL" so the tests read like the source. */
function kinds(code: string): string[] {
  return lex(code).map((t) => (t.virtual ? "NL" : t.kind));
}

describe("lexer", () => {
  test("numbers, including underscores and exponents", () => {
    const values = lex("42 3.14 1_000_000 6.02e23 1e-3").slice(0, 5).map((t) => t.value);
    assert.deepEqual(values, [42, 3.14, 1_000_000, 6.02e23, 0.001]);
  });

  test("a dot after a number is member access, not a decimal point", () => {
    assert.deepEqual(kinds("x.y 1.5"), ["identifier", ".", "identifier", "number", "eof"]);
  });

  test("keywords, identifiers and two-character operators", () => {
    assert.deepEqual(kinds("let x_1 = a |> f ** 2 != b"),
      ["let", "identifier", "=", "identifier", "|>", "identifier", "**", "number", "!=", "identifier", "eof"]);
  });

  test("string escapes", () => {
    const [token] = lex(String.raw`"tab\tquote\" newline\n dollar\${} smile\u{1F600}"`);
    assert.equal(token!.kind, "string");
    assert.equal(token!.value, 'tab\tquote" newline\n dollar${} smile😀');
  });

  test("interpolated strings record the source range of each expression", () => {
    const code = '"a ${x + 1} b ${f("}")}"';
    const [token] = lex(code);
    assert.equal(token!.kind, "template");
    const parts = token!.parts!.map((p) => (p.kind === "text" ? p.value : code.slice(p.span.start, p.span.end)));
    assert.deepEqual(parts, ["a ", "x + 1", " b ", 'f("}")']);
  });

  test("comments are skipped", () => {
    assert.deepEqual(kinds("1 // one\n// alone\n2"), ["number", "NL", "number", "eof"]);
  });

  describe("automatic semicolons", () => {
    test("a newline after a complete expression ends the statement", () => {
      assert.deepEqual(kinds("x = 1\ny = 2"), ["identifier", "=", "number", "NL", "identifier", "=", "number", "eof"]);
    });

    test("a newline after an operator does not", () => {
      assert.deepEqual(kinds("x = 1 +\n2"), ["identifier", "=", "number", "+", "number", "eof"]);
    });

    test("no semicolons inside parentheses or brackets", () => {
      assert.deepEqual(kinds("f(1,\n2)\n[3,\n4]"), ["identifier", "(", "number", ",", "number", ")", "NL", "[", "number", ",", "number", "]", "eof"]);
    });

    test("a line starting with |>, ., else, and, or continues the previous one", () => {
      assert.ok(!kinds("xs\n  |> f()").includes("NL"));
      assert.ok(!kinds("a\n  .b").includes("NL"));
      assert.ok(!kinds("if x {\n}\nelse {\n}").slice(0, -1).includes("NL"));
      assert.ok(!kinds("a\n  and b").includes("NL"));
    });

    test("blank lines and comments between statements insert only one semicolon", () => {
      assert.deepEqual(kinds("a\n\n// note\n\nb"), ["identifier", "NL", "identifier", "eof"]);
    });

    test("an unclosed bracket does not swallow the rest of the file", () => {
      assert.deepEqual(kinds("let a = [1\nlet b = 2\nc"),
        ["let", "identifier", "=", "[", "number", "NL", "let", "identifier", "=", "number", "NL", "identifier", "eof"]);
    });
  });

  test("errors are reported without stopping", () => {
    const result = tokenize(new SourceFile("t", 'a @ b "open'));
    assert.deepEqual(result.errors.map((e) => e.message), ["unexpected character '@'", "unterminated string"]);
    assert.deepEqual(result.tokens.map((t) => t.kind), ["identifier", "error", "identifier", "error", "eof"]);
  });

  test("spans point at the exact source text", () => {
    const code = "let total = 10";
    for (const token of lex(code).slice(0, -1)) {
      assert.equal(code.slice(token.span.start, token.span.end), token.text);
    }
  });
});
