import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { editDistance } from "../src/resolver.js";
import { diagnostics, output } from "./helpers.js";

/** Messages (with hints) of the compile-time errors in a program. */
function errors(code: string): string[] {
  return diagnostics(code).map((d) => (d.hint ? `${d.message} (${d.hint})` : d.message));
}

describe("resolver", () => {
  test("undefined variables suggest a close match", () => {
    assert.deepEqual(errors("let count = 1\nprint(cuont)"), ["undefined variable 'cuont' (did you mean 'count'?)"]);
    assert.deepEqual(errors("pritn(1)"), ["undefined variable 'pritn' (did you mean 'print'?)"]);
    assert.deepEqual(errors("print(zzz)"), ["undefined variable 'zzz'"]);
  });

  test("names from other languages get a pointer to Fern's spelling", () => {
    assert.deepEqual(errors("let x = null"), ["undefined variable 'null' (Fern spells it 'nil')"]);
    assert.deepEqual(errors("let ok = True"), ["undefined variable 'True' (Fern spells it 'true')"]);
  });

  test("constants, functions and built-ins can't be reassigned", () => {
    assert.match(errors("const a = 1\na = 2")[0]!, /^can't assign to constant 'a'/);
    assert.match(errors("fn f() => 1\nf = 2")[0]!, /^can't assign to function 'f'/);
    assert.match(errors("print = 1")[0]!, /^can't assign to built-in 'print'/);
  });

  test("built-ins can be shadowed by your own variables", () => {
    assert.deepEqual(output("let len = 5\nprint(len)"), ["5"]);
  });

  test("duplicate declarations in one scope, with a note pointing at the first", () => {
    const [d] = diagnostics("let a = 1\nlet a = 2");
    assert.equal(d!.message, "'a' is already declared in this scope");
    assert.equal(d!.note!.message, "'a' was first declared here");
    assert.deepEqual(errors("let a = 1\n{ let a = 2 }"), [], "shadowing in an inner block is fine");
  });

  test("a parameter and a local with the same name clash", () => {
    assert.deepEqual(diagnostics("fn f(x) { let x = 1 }").map((d) => d.message), ["'x' is already declared in this scope"]);
  });

  test("using a variable before its let runs", () => {
    assert.deepEqual(errors("print(x)\nlet x = 1"), ["can't use 'x' before it is defined (move the 'let x' above this line)"]);
    assert.deepEqual(errors("let x = x + 1"), ["can't use 'x' in its own initializer"]);
  });

  test("functions may refer to later declarations, since they run later", () => {
    assert.deepEqual(output("fn show() { print(late) }\nlet late = 'ok'\nshow()".replace(/'/g, '"')), ["ok"]);
  });

  test("function declarations are hoisted, so mutual recursion works", () => {
    const code = `
      print(is_even(10))
      fn is_even(n) { if n == 0 { return true } return is_odd(n - 1) }
      fn is_odd(n) { if n == 0 { return false } return is_even(n - 1) }`;
    assert.deepEqual(output(code), ["true"]);
  });

  test("return, break and continue must be in the right place", () => {
    assert.deepEqual(errors("return 1"), ["'return' outside a function"]);
    assert.deepEqual(errors("break"), ["'break' outside a loop"]);
    assert.deepEqual(errors("while true { fn f() { continue } }"), ["'continue' outside a loop"]);
  });

  test("all name errors are reported at once", () => {
    assert.equal(diagnostics("print(a)\nprint(b)\nprint(c)").length, 3);
  });

  test("edit distance counts a swap of neighbours as one edit", () => {
    assert.equal(editDistance("cuont", "count"), 1);
    assert.equal(editDistance("kitten", "sitting"), 3);
    assert.equal(editDistance("abc", "abc"), 0);
  });
});
