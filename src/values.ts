import type { FunctionExpr } from "./ast.js";

/**
 * Fern values map directly onto JavaScript ones: numbers are doubles, strings and booleans are themselves, nil is
 * `null`, lists are arrays and maps are `Map`s with string keys. Only functions need classes of their own.
 */
export type Value = null | boolean | number | string | Value[] | FernMap | Closure | Builtin;
export type FernMap = Map<string, Value>;

/** Marks a hoisted variable whose `let` has not run yet. */
export const UNINITIALIZED: unique symbol = Symbol("uninitialized");

/** One scope's variables, stored by slot index as the resolver laid them out. */
export class Env {
  readonly slots: (Value | typeof UNINITIALIZED)[];

  constructor(
    size: number,
    readonly parent: Env | null,
  ) {
    this.slots = new Array(size).fill(UNINITIALIZED);
  }
}

/** A user-defined function together with the scope it was created in. */
export class Closure {
  constructor(
    readonly fn: FunctionExpr,
    readonly env: Env,
  ) {}

  get name(): string {
    return this.fn.name || "anonymous fn";
  }
}

/** What a built-in function can do besides computing a value: call back into Fern, and print. */
export interface NativeContext {
  call(fn: Value, args: Value[]): Value;
  print(text: string): void;
}

/** A built-in function. It reports bad arguments by throwing {@link NativeError}. */
export class Builtin {
  constructor(
    readonly name: string,
    readonly minArgs: number,
    readonly maxArgs: number,
    readonly impl: (args: Value[], ctx: NativeContext) => Value,
  ) {}
}

/** Thrown by built-ins; the interpreter turns it into a runtime error pointing at the call. */
export class NativeError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

export function typeName(value: Value): string {
  if (value === null) return "nil";
  if (Array.isArray(value)) return "list";
  if (value instanceof Map) return "map";
  if (value instanceof Closure || value instanceof Builtin) return "function";
  if (typeof value === "boolean") return "bool";
  return typeof value;
}

/** Only `false` and `nil` are falsy, as in Lua and Ruby. 0, "" and [] are all truthy. */
export function isTruthy(value: Value): boolean {
  return value !== null && value !== false;
}

/** Text for `print` and string interpolation: strings appear as-is. */
export function show(value: Value): string {
  return typeof value === "string" ? value : repr(value);
}

/** Text for values inside lists and maps: strings are quoted, so ["1", 1] is not ambiguous. */
export function repr(value: Value, seen: Set<object> = new Set()): string {
  if (value === null) return "nil";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (value instanceof Closure) return `<fn ${value.name}>`;
  if (value instanceof Builtin) return `<built-in ${value.name}>`;
  if (seen.has(value)) return Array.isArray(value) ? "[...]" : "{...}";
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => repr(item, seen)).join(", ")}]`;
    const entries = [...value].map(([key, item]) => `${/^[A-Za-z_]\w*$/.test(key) ? key : JSON.stringify(key)}: ${repr(item, seen)}`);
    return `{${entries.join(", ")}}`;
  } finally {
    seen.delete(value);
  }
}

export function formatNumber(n: number): string {
  if (Object.is(n, -0)) return "0";
  if (Number.isNaN(n)) return "nan";
  if (!Number.isFinite(n)) return n > 0 ? "inf" : "-inf";
  return String(n);
}

/** Structural equality: [1, [2]] == [1, [2]] and {a: 1} == {a: 1}. Functions are equal only to themselves. */
export function equals(a: Value, b: Value, depth = 0): boolean {
  if (a === b) return true;
  if (depth > 100) return false; // a list that contains itself
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => equals(item, b[i]!, depth + 1));
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [key, item] of a) {
      if (!b.has(key) || !equals(item, b.get(key)!, depth + 1)) return false;
    }
    return true;
  }
  return false;
}
