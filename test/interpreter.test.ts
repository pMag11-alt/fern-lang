import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { run, Session } from "../src/index.js";
import { evaluate, firstError, output, printed } from "./helpers.js";

describe("interpreter", () => {
  describe("values and operators", () => {
    const cases: [string, string][] = [
      ["1 + 2 * 3", "7"],
      ["7 / 2", "3.5"],
      ["2 ** 10", "1024"],
      ["-7 % 3", "2"],
      ["0.1 + 0.2", "0.30000000000000004"],
      ['"ab" + "cd"', "abcd"],
      ['"ha" * 3', "hahaha"],
      ["[1, 2] + [3]", "[1, 2, 3]"],
      ["3 > 2 and 2 > 1", "true"],
      ['"apple" < "banana"', "true"],
      ["nil or 5", "5"],
      ["0 or 5", "0"],
      ["false and 1 / 0", "false"], // short-circuits: the division never runs
      ["not nil", "true"],
      ["[1, [2, 3]] == [1, [2, 3]]", "true"],
      ['{a: 1, b: [2]} == {b: [2], a: 1}', "true"],
      ["1 == 1.0", "true"],
      ['1 == "1"', "false"],
      ['[nil, true, "s", 1.5]', '[nil, true, "s", 1.5]'],
      ['{name: "Ada", "two words": 2}', '{name: "Ada", "two words": 2}'],
    ];
    for (const [expression, expected] of cases) {
      test(expression, () => assert.equal(evaluate(expression), expected));
    }
  });

  test("string interpolation evaluates expressions", () => {
    assert.equal(printed('let n = 3\nprint("${n} squared is ${n * n}, list ${[n]}")'), "3 squared is 9, list [3]");
  });

  test("closures capture variables, not values", () => {
    const code = `
      fn counter() {
        let n = 0
        return fn() { n += 1; return n }
      }
      let c = counter()
      c(); c()
      print(c())`;
    assert.equal(printed(code), "3");
  });

  test("each loop iteration has its own variable", () => {
    const code = `
      let fns = []
      for i in range(3) { push(fns, fn() => i) }
      print(map(fns, fn(f) => f()))`;
    assert.equal(printed(code), "[0, 1, 2]");
  });

  test("block scoping and shadowing", () => {
    assert.deepEqual(output("let x = 1\n{ let x = 2\n print(x) }\nprint(x)"), ["2", "1"]);
  });

  test("break and continue", () => {
    const code = `
      let seen = []
      for i in range(10) {
        if i % 2 == 0 { continue }
        if i > 6 { break }
        push(seen, i)
      }
      print(seen)`;
    assert.equal(printed(code), "[1, 3, 5]");
  });

  test("return from inside nested loops", () => {
    const code = `
      fn find_pair(xs, target) {
        for a in xs { for b in xs { if a + b == target { return [a, b] } } }
        return nil
      }
      print(find_pair([1, 4, 6, 9], 15))`;
    assert.equal(printed(code), "[6, 9]");
  });

  test("for loops over lists, strings and map keys", () => {
    assert.deepEqual(output('for c in "hi" { print(c) }'), ["h", "i"]);
    assert.deepEqual(output("for k in ({a: 1, b: 2}) { print(k) }"), ["a", "b"]);
  });

  test("lists and maps are mutable, with negative indexes", () => {
    const code = `
      let xs = [1, 2, 3]
      xs[0] = 10
      xs[-1] += 5
      let m = {}
      m["k"] = 1
      m.k += 1
      print(xs, m, xs[-2], m.missing)`;
    assert.equal(printed(code), '[10, 2, 8] {k: 2} 2 nil');
  });

  test("recursion", () => {
    assert.equal(printed("fn fact(n) => n <= 1 and 1 or n * fact(n - 1)\nprint(fact(20))"), "2432902008176640000");
  });

  test("the last expression is returned for the REPL", () => {
    const session = new Session({ print: () => {} });
    session.evaluate("let x = 20");
    session.evaluate("fn double(n) => n * 2");
    assert.equal(session.evaluate("double(x) + 2").value, 42);
    session.evaluate("let x = 1"); // redeclaring a global is fine in the REPL
    assert.equal(session.evaluate("x").value, 1);
  });

  test("a REPL entry that fails to compile leaves no trace", () => {
    const session = new Session({ print: () => {} });
    assert.throws(() => session.evaluate("let y = nope"));
    assert.throws(() => session.evaluate("y"), /undefined variable 'y'/);
  });

  describe("runtime errors", () => {
    const cases: [string, string][] = [
      ['1 + "a"', "can't add number and string"],
      ['"a" - 1', "'-' needs two numbers, got string and number"],
      ["10 / 0", "division by zero"],
      ["[1, 2][5]", "index 5 is out of range for length 2"],
      ["[1, 2][0.5]", "list index must be a whole number, got 0.5"],
      ["nil()", "nil is not a function"],
      ["let s = \"abc\"\ns[0] = \"x\"", "strings can't be changed in place"],
      ["let m = {}\nm[1]", "map keys are strings, got number"],
      ["[1].length", "can't read '.length' of list"],
      ["fn f(a) => a\nf(1, 2)", "f() takes 1 argument, got 2"],
      ["len(1, 2)", "len() takes 1 argument, got 2"],
      ["for x in 5 {}", "can't loop over number"],
      ['1 < "2"', "can't compare number with string"],
      ['assert(1 == 2, "math broke")', "assertion failed: math broke"],
      ['panic("custom failure")', "custom failure"],
    ];
    for (const [code, message] of cases) {
      test(message, () => assert.equal(firstError(code).message, message));
    }

    test("hints help fix the mistake", () => {
      assert.equal(firstError('print("n=" + 1)').hint, 'convert with str(), or use "${...}" in a string');
      assert.equal(firstError("[1].length").hint, "use len(...)");
      assert.equal(firstError("for i in 3 {}").hint, "use range(3) to count");
    });

    test("errors in built-in callbacks point at the right call", () => {
      const code = "let xs = [1, 2]\nprint(map(xs, fn(x) => x / 0))";
      const error = firstError(code);
      assert.equal(error.message, "division by zero");
      assert.equal(code.slice(error.span.start, error.span.end), "x / 0");
    });

    test("a stack trace lists every active call", () => {
      const code = "fn a() => b()\nfn b() => c()\nfn c() => nil + 1\na()";
      const result = run(code);
      assert.match(result.errors[0]!, /at c \(main\.fern:3:11\)\n  at b \(main\.fern:2:11\)\n  at a \(main\.fern:1:11\)\n  at <main> \(main\.fern:4:1\)/);
    });

    test("runaway recursion is a stack overflow, not a crash", () => {
      const error = firstError("fn forever(n) => forever(n + 1)\nforever(0)");
      assert.match(error.message, /^stack overflow/);
      assert.equal(error.hint, "check that the recursion has a base case");
    });

    test("output printed before an error is kept", () => {
      const result = run('print("before")\nprint(1 / 0)\nprint("after")');
      assert.deepEqual(result.output, ["before"]);
      assert.equal(result.ok, false);
    });
  });
});
