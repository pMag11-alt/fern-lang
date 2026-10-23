import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parse, printProgram, SourceFile } from "../src/index.js";

/** Parses and prints back as S-expressions, asserting there were no syntax errors. */
function tree(code: string): string {
  const { program, errors } = parse(new SourceFile("test.fern", code));
  assert.deepEqual(errors.map((e) => e.message), []);
  return printProgram(program);
}

function syntaxErrors(code: string): string[] {
  return parse(new SourceFile("test.fern", code)).errors.map((e) => e.message);
}

describe("parser", () => {
  describe("precedence and associativity", () => {
    const cases: [string, string][] = [
      ["1 + 2 * 3", "(+ 1 (* 2 3))"],
      ["(1 + 2) * 3", "(* (+ 1 2) 3)"],
      ["1 - 2 - 3", "(- (- 1 2) 3)"],
      ["2 ** 3 ** 2", "(** 2 (** 3 2))"],
      ["-2 ** 2", "(- (** 2 2))"],
      ["a or b and c", "(or a (and b c))"],
      ["not a == b", "(== (not a) b)"],
      ["a < b == c > d", "(== (< a b) (> c d))"],
      ["x = y = 1", "(= x (= y 1))"],
      ["total += price * qty", "(+= total (* price qty))"],
      ["a.b.c(1)[2]", "(index (call (. (. a b) c) 1) 2)"],
      ["-x.y", "(- (. x y))"],
    ];
    for (const [code, expected] of cases) {
      test(code, () => assert.equal(tree(code), expected));
    }
  });

  test("pipelines insert the left side as the first argument", () => {
    assert.equal(tree("xs |> map(f) |> sum"), "(call sum (call map xs f))");
    assert.equal(tree("x + 1 |> f"), "(call f (+ x 1))");
  });

  test("literals", () => {
    assert.equal(tree('[1, "two", [3], nil, true]'), '(list 1 "two" (list 3) nil true)');
    assert.equal(tree('let m = {name: "Ada", "full name": x, age}'), '(let m (map (name "Ada") (full name x) (age age)))');
    assert.equal(tree('"sum: ${a + b}!"'), '(template "sum: " (+ a b) "!")');
  });

  test("trailing commas and multi-line literals", () => {
    assert.equal(tree("let xs = [\n  1,\n  2,\n]"), "(let xs (list 1 2))");
    assert.equal(tree("let m = {\n  a: 1,\n  b: 2\n}"), "(let m (map (a 1) (b 2)))");
  });

  test("functions: declarations, arrows and blocks", () => {
    assert.equal(tree("fn sq(x) => x * x"), "(fn sq (x) (* x x))");
    assert.equal(tree("let add = fn(a, b) { return a + b }"), "(let add (fn add (a b)\n  (return (+ a b))))");
  });

  test("control flow", () => {
    assert.equal(tree("if a { b } else if c { d } else { e }"),
      "(if a\n  b\n  else\n    (if c\n      d\n      else\n        e))");
    assert.equal(tree("while i < 3 { i += 1 }"), "(while (< i 3)\n  (+= i 1))");
    assert.equal(tree("for x in xs { if x { break } }"), "(for x xs\n  (if x\n    (break)))");
  });

  test("a `{` after an if condition starts the block, not a map", () => {
    assert.equal(tree("if ready {}"), "(if ready)");
    assert.equal(tree("if x == ({a: 1}) {}"), "(if (== x (map (a 1))))");
    assert.deepEqual(syntaxErrors("for k in {a: 1} {}")[0], "expected an expression, found '{'");
  });

  test("semicolons are optional but allowed", () => {
    assert.equal(tree("a = 1; b = 2;"), tree("a = 1\nb = 2"));
  });

  describe("errors", () => {
    test("reports a missing closing bracket with where it was opened", () => {
      const { errors } = parse(new SourceFile("t", "print(1, 2"));
      assert.equal(errors[0]!.message, "expected ')' after the arguments, found the end of the file");
      assert.equal(errors[0]!.note!.message, "the '(' was opened here");
    });

    test("two statements on one line need a separator", () => {
      assert.deepEqual(syntaxErrors("let a = 1 let b = 2"), ["expected the statement to end before 'let'"]);
    });

    test("recovers after an error and keeps reporting", () => {
      assert.deepEqual(syntaxErrors("let = 5\nlet ok = 1\nprint(1 +)\nconst c"), [
        "expected a variable name after 'let', found '='",
        "expected an expression, found ')'",
        "constant 'c' needs a value",
      ]);
    });

    test("invalid assignment targets", () => {
      assert.deepEqual(syntaxErrors("1 = 2"), ["can't assign to this"]);
      assert.deepEqual(syntaxErrors("f() = 2"), ["can't assign to this"]);
    });

    test("unclosed block", () => {
      assert.deepEqual(syntaxErrors("fn f() {\n  return 1\n"), ["this '{' is never closed"]);
    });

    test("errors inside string interpolation point into the string", () => {
      const code = 'print("x = ${x +}")';
      const { errors } = parse(new SourceFile("t", code));
      assert.equal(errors.length, 1);
      assert.equal(code.slice(errors[0]!.span.start, errors[0]!.span.end + 1), "}");
    });
  });
});
