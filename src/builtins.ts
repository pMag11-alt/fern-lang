import {
  Builtin, Closure, equals, NativeError, show, typeName,
  type FernMap, type NativeContext, type Value,
} from "./values.js";

const MAX_RANGE = 10_000_000;

const list = (fn: string, v: Value): Value[] => {
  if (!Array.isArray(v)) throw new NativeError(`${fn}() expects a list, got ${typeName(v)}`);
  return v;
};

const map = (fn: string, v: Value): FernMap => {
  if (!(v instanceof Map)) throw new NativeError(`${fn}() expects a map, got ${typeName(v)}`);
  return v;
};

const string = (fn: string, v: Value): string => {
  if (typeof v !== "string") throw new NativeError(`${fn}() expects a string, got ${typeName(v)}`);
  return v;
};

const number = (fn: string, v: Value): number => {
  if (typeof v !== "number") throw new NativeError(`${fn}() expects a number, got ${typeName(v)}`);
  return v;
};

const integer = (fn: string, v: Value): number => {
  const n = number(fn, v);
  if (!Number.isInteger(n)) throw new NativeError(`${fn}() expects a whole number, got ${n}`);
  return n;
};

const callable = (fn: string, v: Value): Closure | Builtin => {
  if (!(v instanceof Closure) && !(v instanceof Builtin)) {
    throw new NativeError(`${fn}() expects a function, got ${typeName(v)}`, "pass a function, e.g. fn(x) => x * 2");
  }
  return v;
};

/** Python-style slice bounds: negative counts from the end, out-of-range values are clamped. */
const bound = (index: number, length: number): number =>
  index < 0 ? Math.max(0, length + index) : Math.min(index, length);

/** Sorts numbers with numbers and strings with strings, and refuses to guess for anything else. */
function compareNatural(a: Value, b: Value): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  // The engine may call the comparator with either argument first, so name the types in a fixed order.
  const [x, y] = [typeName(a), typeName(b)].sort();
  throw new NativeError(`sort() can't compare ${x} with ${y}`,
    "pass a key function, e.g. sort(people, fn(p) => p.age)");
}

function paramCount(f: Closure | Builtin): number {
  return f instanceof Closure ? f.fn.params.length : f.minArgs;
}

type Impl = (args: Value[], ctx: NativeContext) => Value;

const definitions: [name: string, minArgs: number, maxArgs: number, impl: Impl][] = [
  // ---- core ----
  ["print", 0, Infinity, (args, ctx) => {
    ctx.print(args.map(show).join(" "));
    return null;
  }],
  ["len", 1, 1, ([v]) => {
    if (typeof v === "string" || Array.isArray(v)) return v.length;
    if (v instanceof Map) return v.size;
    throw new NativeError(`len() expects a string, list or map, got ${typeName(v!)}`);
  }],
  ["type", 1, 1, ([v]) => typeName(v!)],
  ["str", 1, 1, ([v]) => show(v!)],
  ["num", 1, 1, ([v]) => toNumber("num", v!)],
  ["int", 1, 1, ([v]) => Math.trunc(toNumber("int", v!))],
  ["range", 1, 3, (args) => {
    const [start, end] = args.length === 1 ? [0, number("range", args[0]!)] : [number("range", args[0]!), number("range", args[1]!)];
    const step = args.length === 3 ? number("range", args[2]!) : 1;
    if (step === 0) throw new NativeError("range() step can't be 0");
    const count = Math.max(0, Math.ceil((end - start) / step));
    if (count > MAX_RANGE) throw new NativeError(`range() would create ${count} numbers; the limit is ${MAX_RANGE}`);
    return Array.from({ length: count }, (_, i) => start + i * step);
  }],
  ["assert", 1, 2, ([cond, message]) => {
    if (cond === null || cond === false) {
      throw new NativeError(message === undefined ? "assertion failed" : `assertion failed: ${show(message)}`);
    }
    return null;
  }],
  ["panic", 1, 1, ([message]) => {
    throw new NativeError(show(message!));
  }],
  ["clock", 0, 0, () => performance.now()],
  ["random", 0, 2, (args) => {
    if (args.length === 0) return Math.random();
    const lo = integer("random", args[0]!);
    const hi = integer("random", args[1] ?? null);
    if (hi < lo) throw new NativeError(`random(${lo}, ${hi}): the second number must not be smaller`);
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  }],

  // ---- lists ----
  ["push", 2, Infinity, ([xs, ...items]) => {
    list("push", xs!).push(...items);
    return xs!;
  }],
  ["pop", 1, 1, ([xs]) => {
    const items = list("pop", xs!);
    if (items.length === 0) throw new NativeError("pop() from an empty list");
    return items.pop()!;
  }],
  ["insert", 3, 3, ([xs, index, item]) => {
    const items = list("insert", xs!);
    let i = integer("insert", index!);
    if (i < 0) i += items.length + 1;
    if (i < 0 || i > items.length) throw new NativeError(`insert() index ${index} is out of range for a list of length ${items.length}`);
    items.splice(i, 0, item!);
    return xs!;
  }],
  ["remove", 2, 2, ([target, key]) => {
    if (target instanceof Map) {
      const k = string("remove", key!);
      const old = target.get(k) ?? null;
      target.delete(k);
      return old;
    }
    const items = list("remove", target!);
    let i = integer("remove", key!);
    if (i < 0) i += items.length;
    if (i < 0 || i >= items.length) throw new NativeError(`remove() index ${key} is out of range for a list of length ${items.length}`);
    return items.splice(i, 1)[0]!;
  }],
  ["map", 2, 2, ([xs, f], ctx) => list("map", xs!).map((x) => ctx.call(callable("map", f!), [x]))],
  ["filter", 2, 2, ([xs, f], ctx) => list("filter", xs!).filter((x) => truthy(ctx.call(callable("filter", f!), [x])))],
  ["reduce", 2, 3, (args, ctx) => {
    const items = list("reduce", args[0]!);
    const f = callable("reduce", args[1]!);
    if (args.length === 2 && items.length === 0) throw new NativeError("reduce() of an empty list needs a starting value");
    let acc: Value = args.length === 3 ? args[2]! : items[0]!;
    for (let i = args.length === 3 ? 0 : 1; i < items.length; i++) acc = ctx.call(f, [acc, items[i]!]);
    return acc;
  }],
  ["each", 2, 2, ([xs, f], ctx) => {
    for (const x of list("each", xs!)) ctx.call(callable("each", f!), [x]);
    return null;
  }],
  ["find", 2, 2, ([xs, f], ctx) => list("find", xs!).find((x) => truthy(ctx.call(callable("find", f!), [x]))) ?? null],
  ["any", 2, 2, ([xs, f], ctx) => list("any", xs!).some((x) => truthy(ctx.call(callable("any", f!), [x])))],
  ["all", 2, 2, ([xs, f], ctx) => list("all", xs!).every((x) => truthy(ctx.call(callable("all", f!), [x])))],
  ["sort", 1, 2, ([xs, f], ctx) => {
    const items = [...list("sort", xs!)];
    if (f === undefined) return items.sort(compareNatural);
    const by = callable("sort", f);
    if (paramCount(by) === 1) {
      // A one-argument function is a key: sort(people, fn(p) => p.age). Keys are computed once per item.
      const keyed = items.map((item) => ({ item, key: ctx.call(by, [item]) }));
      keyed.sort((a, b) => compareNatural(a.key, b.key));
      return keyed.map((k) => k.item);
    }
    return items.sort((a, b) => {
      const result = ctx.call(by, [a, b]);
      if (typeof result !== "number") throw new NativeError(`sort() comparison must return a number, got ${typeName(result)}`);
      return result;
    });
  }],
  ["reverse", 1, 1, ([v]) => (typeof v === "string" ? [...v].reverse().join("") : [...list("reverse", v!)].reverse())],
  ["join", 1, 2, ([xs, sep]) => list("join", xs!).map(show).join(sep === undefined ? "" : string("join", sep))],
  ["slice", 2, 3, ([v, start, end]) => {
    if (typeof v !== "string" && !Array.isArray(v)) throw new NativeError(`slice() expects a list or string, got ${typeName(v!)}`);
    const from = bound(integer("slice", start!), v.length);
    const to = end === undefined || end === null ? v.length : bound(integer("slice", end), v.length);
    return v.slice(from, Math.max(from, to));
  }],
  ["contains", 2, 2, ([haystack, needle]) => {
    if (typeof haystack === "string") return haystack.includes(string("contains", needle!));
    if (haystack instanceof Map) return haystack.has(string("contains", needle!));
    return list("contains", haystack!).some((item) => equals(item, needle!));
  }],
  ["index_of", 2, 2, ([haystack, needle]) => {
    if (typeof haystack === "string") return haystack.indexOf(string("index_of", needle!));
    return list("index_of", haystack!).findIndex((item) => equals(item, needle!));
  }],
  ["sum", 1, 1, ([xs]) => list("sum", xs!).reduce((total: number, x) => total + number("sum", x), 0)],
  ["min", 1, Infinity, (args) => extreme("min", args, (a, b) => a < b)],
  ["max", 1, Infinity, (args) => extreme("max", args, (a, b) => a > b)],

  // ---- maps ----
  ["keys", 1, 1, ([m]) => [...map("keys", m!).keys()]],
  ["values", 1, 1, ([m]) => [...map("values", m!).values()]],
  ["entries", 1, 1, ([m]) => [...map("entries", m!)].map(([k, v]) => [k, v])],
  ["has", 2, 2, ([m, key]) => map("has", m!).has(string("has", key!))],

  // ---- strings ----
  ["split", 2, 2, ([s, sep]) => {
    const text = string("split", s!);
    const separator = string("split", sep!);
    return separator === "" ? [...text] : text.split(separator);
  }],
  ["upper", 1, 1, ([s]) => string("upper", s!).toUpperCase()],
  ["lower", 1, 1, ([s]) => string("lower", s!).toLowerCase()],
  ["trim", 1, 1, ([s]) => string("trim", s!).trim()],
  ["starts_with", 2, 2, ([s, prefix]) => string("starts_with", s!).startsWith(string("starts_with", prefix!))],
  ["ends_with", 2, 2, ([s, suffix]) => string("ends_with", s!).endsWith(string("ends_with", suffix!))],
  ["replace", 3, 3, ([s, from, to]) => string("replace", s!).replaceAll(string("replace", from!), string("replace", to!))],
  ["chars", 1, 1, ([s]) => [...string("chars", s!)]],
  ["ord", 1, 1, ([c]) => {
    const text = string("ord", c!);
    if ([...text].length !== 1) throw new NativeError(`ord() expects a single character, got ${JSON.stringify(text)}`);
    return text.codePointAt(0)!;
  }],
  ["chr", 1, 1, ([n]) => {
    const code = integer("chr", n!);
    if (code < 0 || code > 0x10ffff) throw new NativeError(`chr() code ${code} is not a valid character`);
    return String.fromCodePoint(code);
  }],

  // ---- math ----
  ["abs", 1, 1, ([n]) => Math.abs(number("abs", n!))],
  ["floor", 1, 1, ([n]) => Math.floor(number("floor", n!))],
  ["ceil", 1, 1, ([n]) => Math.ceil(number("ceil", n!))],
  ["round", 1, 1, ([n]) => Math.round(number("round", n!))],
  ["sqrt", 1, 1, ([n]) => Math.sqrt(number("sqrt", n!))],
];

function truthy(v: Value): boolean {
  return v !== null && v !== false;
}

function toNumber(fn: string, v: Value): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(v)) return Number(v);
  throw new NativeError(`${fn}() can't convert ${typeof v === "string" ? JSON.stringify(v) : typeName(v)} to a number`);
}

/** min/max accept either several numbers or a single list of them. */
function extreme(fn: string, args: Value[], better: (a: number, b: number) => boolean): number {
  const items = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
  if (items.length === 0) throw new NativeError(`${fn}() of an empty list`);
  let best = number(fn, items[0]!);
  for (const item of items.slice(1)) {
    const n = number(fn, item);
    if (better(n, best)) best = n;
  }
  return best;
}

export const BUILTINS: readonly Builtin[] = definitions.map(([name, min, max, impl]) => new Builtin(name, min, max, impl));

/** Names in slot order. The resolver and interpreter both lay out the built-in scope from this list. */
export const BUILTIN_NAMES: readonly string[] = BUILTINS.map((b) => b.name);
