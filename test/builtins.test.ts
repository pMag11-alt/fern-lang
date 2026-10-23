import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { evaluate, firstError } from "./helpers.js";

describe("built-in functions", () => {
  const cases: [string, string][] = [
    ["len([1, 2, 3])", "3"],
    ['len("héllo")', "5"],
    ["len({a: 1})", "1"],
    ["type(fn() => 1)", "function"],
    ["str(1.5) + str([1])", "1.5[1]"],
    ['num(" 42 ") + 1', "43"],
    ['int("7.9")', "7"],
    ["range(5)", "[0, 1, 2, 3, 4]"],
    ["range(10, 0, -3)", "[10, 7, 4, 1]"],
    ["range(3, 3)", "[]"],
    ["push([1], 2, 3)", "[1, 2, 3]"],
    ["insert([1, 3], 1, 2)", "[1, 2, 3]"],
    ["remove([1, 2, 3], -1)", "3"],
    ['remove({a: 1}, "a")', "1"],
    ["map([1, 2], fn(x) => x * 10)", "[10, 20]"],
    ["filter(range(10), fn(x) => x % 3 == 0)", "[0, 3, 6, 9]"],
    ["reduce([1, 2, 3, 4], fn(a, b) => a * b)", "24"],
    ['reduce([], fn(a, b) => a + b, "empty")', "empty"],
    ["find([5, 8, 12], fn(x) => x > 6)", "8"],
    ["find([1], fn(x) => x > 6)", "nil"],
    ["any([1, 2], fn(x) => x > 1) and not all([1, 2], fn(x) => x > 1)", "true"],
    ["sort([3, 1, 2])", "[1, 2, 3]"],
    ['sort(["pear", "Apple", "fig"])', '["Apple", "fig", "pear"]'],
    ["sort([3, 1, 2], fn(a, b) => b - a)", "[3, 2, 1]"],
    ['sort(["ccc", "a", "bb"], len)', '["a", "bb", "ccc"]'],
    ['reverse("abc") + str(reverse([1, 2]))', "cba[2, 1]"],
    ['join([1, "a", nil], "-")', "1-a-nil"],
    ['split("a,b,,c", ",")', '["a", "b", "", "c"]'],
    ['split("hey", "")', '["h", "e", "y"]'],
    ["slice([1, 2, 3, 4], 1, -1)", "[2, 3]"],
    ['slice("hello", -3)', "llo"],
    ["contains([[1], [2]], [2])", "true"],
    ['contains("haystack", "st") and contains({k: 1}, "k")', "true"],
    ['index_of([4, 5, 6], 6) + index_of("abc", "z")', "1"],
    ["sum([1.5, 2.5])", "4"],
    ["min(3, 1, 2) + max([3, 1, 2])", "4"],
    ['keys({a: 1, b: 2})', '["a", "b"]'],
    ['entries({a: 1})', '[["a", 1]]'],
    ['has({a: nil}, "a")', "true"],
    ['upper("abc") + lower("DEF") + trim("  x  ")', "ABCdefx"],
    ['starts_with("fern.lang", "fern") and ends_with("fern.lang", ".lang")', "true"],
    ['replace("a-b-c", "-", "+")', "a+b+c"],
    ['chars("hi")', '["h", "i"]'],
    ['chr(ord("a") + 1)', "b"],
    ["abs(-2) + floor(2.7) + ceil(2.1) + round(2.5)", "10"],
    ["sqrt(16)", "4"],
  ];
  for (const [expression, expected] of cases) {
    test(expression, () => assert.equal(evaluate(expression), expected));
  }

  test("random numbers stay in range", () => {
    const values = evaluate("map(range(200), fn(i) => random(1, 6))").slice(1, -1).split(", ").map(Number);
    assert.ok(values.every((v) => Number.isInteger(v) && v >= 1 && v <= 6));
    assert.equal(new Set(values).size, 6);
  });

  test("bad arguments are reported against the call", () => {
    assert.equal(firstError("pop([])").message, "pop() from an empty list");
    assert.equal(firstError('num("abc")').message, 'num() can\'t convert "abc" to a number');
    assert.equal(firstError("map(1, len)").message, "map() expects a list, got number");
    assert.equal(firstError("map([1], 2)").message, "map() expects a function, got number");
    assert.equal(firstError("sort([1, \"a\"])").message, "sort() can't compare number with string");
    assert.equal(firstError("range(0, 1e9)").message, "range() would create 1000000000 numbers; the limit is 10000000");
    assert.equal(firstError("reduce([], fn(a, b) => a)").message, "reduce() of an empty list needs a starting value");
  });
});
