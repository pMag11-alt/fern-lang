import type { AssignOp, BinaryOp, Binding, Expr, FunctionExpr, Identifier, Program, Stmt } from "./ast.js";
import { BUILTINS } from "./builtins.js";
import { RuntimeError } from "./errors.js";
import type { Span } from "./source.js";
import {
  Builtin, Closure, Env, equals, isTruthy, NativeError, show, typeName, UNINITIALIZED,
  type NativeContext, type Value,
} from "./values.js";

/** How a statement finished: normally (undefined), or by break, continue or return. */
type Completion = undefined | typeof BREAK | typeof CONTINUE | ReturnValue;
const BREAK = Symbol("break");
const CONTINUE = Symbol("continue");

class ReturnValue {
  constructor(readonly value: Value) {}
}

export interface InterpreterOptions {
  /** Receives each line printed by the program. */
  print?: (text: string) => void;
  /** Deepest allowed call nesting before a "stack overflow" error. */
  maxCallDepth?: number;
  /**
   * Called every 1024 loop iterations or function calls. The playground's worker uses it to send buffered output
   * while a long computation is still running.
   */
  heartbeat?: () => void;
}

/**
 * A tree-walking interpreter. It evaluates the AST directly, using the slots the resolver assigned to look up
 * variables in O(depth) without any name lookups.
 *
 * Control flow does not use exceptions: each statement returns a completion (normal, break, continue or return)
 * that loops and calls inspect. Exceptions are only used for runtime errors, which collect a stack trace as they
 * unwind through function calls.
 */
export class Interpreter {
  private readonly prelude: Env;
  private readonly printLine: (text: string) => void;
  private readonly maxCallDepth: number;
  private callDepth = 0;
  private readonly heartbeat: (() => void) | undefined;
  private ticks = 0;
  private readonly context: NativeContext;
  /** Top-level variables. The REPL reuses it across inputs, growing it as new globals appear. */
  readonly globals: Env;

  constructor(options: InterpreterOptions = {}) {
    this.printLine = options.print ?? ((text) => console.log(text));
    this.maxCallDepth = options.maxCallDepth ?? 1000;
    this.heartbeat = options.heartbeat;
    this.prelude = new Env(BUILTINS.length, null);
    BUILTINS.forEach((builtin, i) => (this.prelude.slots[i] = builtin));
    this.globals = new Env(0, this.prelude);
    this.context = {
      call: (fn, args) => this.callValue(fn, args, this.nativeCallSpan),
      print: (text) => this.printLine(text),
    };
  }

  /** The call site of the built-in currently running, so errors in callbacks point at the right line. */
  private nativeCallSpan: Span = { start: 0, end: 0 };

  /** Runs a resolved program. Returns the value of the last expression statement, which the REPL echoes. */
  run(program: Program): Value {
    const size = program.scopeSize ?? 0;
    while (this.globals.slots.length < size) this.globals.slots.push(UNINITIALIZED);
    let last: Value = null;
    try {
      this.hoistFunctions(program.body, this.globals);
      for (const stmt of program.body) {
        last = stmt.type === "Expr" ? this.evaluate(stmt.expr, this.globals) : null;
        if (stmt.type !== "Expr") this.execute(stmt, this.globals);
      }
    } catch (e) {
      if (e instanceof RuntimeError && e.trace.length > 0) {
        e.trace.push({ name: "<main>", span: pendingSpan(e) });
      }
      throw e;
    }
    return last;
  }

  // ---- statements ----------------------------------------------------------------------------------------------

  private execute(stmt: Stmt, env: Env): Completion {
    switch (stmt.type) {
      case "Expr":
        this.evaluate(stmt.expr, env);
        return undefined;
      case "Let":
        env.slots[stmt.binding!.index] = stmt.init ? this.evaluate(stmt.init, env) : null;
        return undefined;
      case "FnDecl":
        return undefined; // created when the enclosing block was entered
      case "Block":
        return this.executeBlock(stmt.body, stmt.scopeSize ? new Env(stmt.scopeSize, env) : env);
      case "If":
        if (isTruthy(this.evaluate(stmt.cond, env))) {
          return this.execute(stmt.then, env);
        }
        return stmt.else ? this.execute(stmt.else, env) : undefined;
      case "While":
        while (isTruthy(this.evaluate(stmt.cond, env))) {
          this.tick();
          const completion = this.execute(stmt.body, env);
          if (completion === BREAK) break;
          if (completion instanceof ReturnValue) return completion;
        }
        return undefined;
      case "For":
        return this.executeFor(stmt, env);
      case "Return":
        return new ReturnValue(stmt.value ? this.evaluate(stmt.value, env) : null);
      case "Break":
        return BREAK;
      case "Continue":
        return CONTINUE;
    }
  }

  private executeBlock(stmts: Stmt[], env: Env): Completion {
    this.hoistFunctions(stmts, env);
    for (const stmt of stmts) {
      const completion = this.execute(stmt, env);
      if (completion !== undefined) return completion;
    }
    return undefined;
  }

  /** Function declarations exist from the start of their block, so they can be called before the `fn` line. */
  private hoistFunctions(stmts: Stmt[], env: Env): void {
    for (const stmt of stmts) {
      if (stmt.type === "FnDecl") env.slots[stmt.binding!.index] = new Closure(stmt.fn, env);
    }
  }

  private executeFor(stmt: Stmt & { type: "For" }, env: Env): Completion {
    const iterable = this.evaluate(stmt.iterable, env);
    let items: Iterable<Value>;
    if (Array.isArray(iterable)) items = [...iterable];
    else if (typeof iterable === "string") items = [...iterable];
    else if (iterable instanceof Map) items = [...iterable.keys()];
    else {
      throw new RuntimeError(`can't loop over ${typeName(iterable)}`, stmt.iterable.span,
        typeof iterable === "number" ? `use range(${show(iterable)}) to count` : undefined);
    }
    for (const item of items) {
      this.tick();
      // A fresh scope per iteration, so a closure made in the loop keeps its own copy of the loop variable.
      const scope = new Env(stmt.scopeSize!, env);
      scope.slots[0] = item;
      const completion = this.executeBlock(stmt.body.body, scope);
      if (completion === BREAK) break;
      if (completion instanceof ReturnValue) return completion;
    }
    return undefined;
  }

  // ---- expressions ---------------------------------------------------------------------------------------------

  private evaluate(expr: Expr, env: Env): Value {
    switch (expr.type) {
      case "Number":
      case "String":
      case "Bool":
        return expr.value;
      case "Nil":
        return null;
      case "Template":
        return expr.parts.map((part) => (typeof part === "string" ? part : show(this.evaluate(part, env)))).join("");
      case "Identifier":
        return this.lookup(expr, env);
      case "List":
        return expr.items.map((item) => this.evaluate(item, env));
      case "Map": {
        const map = new Map<string, Value>();
        for (const entry of expr.entries) map.set(entry.key, this.evaluate(entry.value, env));
        return map;
      }
      case "Unary": {
        const operand = this.evaluate(expr.operand, env);
        if (expr.op === "not") return !isTruthy(operand);
        if (typeof operand !== "number") {
          throw new RuntimeError(`can't negate ${typeName(operand)}`, expr.span);
        }
        return -operand;
      }
      case "Binary":
        return this.binary(expr.op, this.evaluate(expr.left, env), this.evaluate(expr.right, env), expr.span);
      case "Logical": {
        const left = this.evaluate(expr.left, env);
        if (expr.op === "and") return isTruthy(left) ? this.evaluate(expr.right, env) : left;
        return isTruthy(left) ? left : this.evaluate(expr.right, env);
      }
      case "Assign":
        return this.assign(expr.op, expr.target, expr.value, env, expr.span);
      case "Call": {
        const callee = this.evaluate(expr.callee, env);
        const args = expr.args.map((arg) => this.evaluate(arg, env));
        return this.callValue(callee, args, expr.span, expr.callee.span);
      }
      case "Index":
        return this.index(this.evaluate(expr.object, env), this.evaluate(expr.index, env), expr.index.span);
      case "Member": {
        const object = this.evaluate(expr.object, env);
        if (object instanceof Map) return object.get(expr.name) ?? null;
        throw new RuntimeError(`can't read '.${expr.name}' of ${typeName(object)}`, expr.nameSpan, memberHint(object, expr.name));
      }
      case "Function":
        return new Closure(expr, env);
    }
  }

  private lookup(id: Identifier, env: Env): Value {
    const value = scopeAt(env, id.binding!).slots[id.binding!.index]!;
    if (value === UNINITIALIZED) {
      throw new RuntimeError(`can't use '${id.name}' before it is defined`, id.span,
        "a function used it before its 'let' line ran");
    }
    return value;
  }

  private assign(op: AssignOp, target: Expr & { type: "Identifier" | "Index" | "Member" }, valueExpr: Expr, env: Env, span: Span): Value {
    const combine = (current: Value, value: Value): Value =>
      op === "=" ? value : this.binary(op.slice(0, -1) as BinaryOp, current, value, span);

    if (target.type === "Identifier") {
      const value = this.evaluate(valueExpr, env);
      const scope = scopeAt(env, target.binding!);
      const result = op === "=" ? value : combine(this.lookup(target, env), value);
      scope.slots[target.binding!.index] = result;
      return result;
    }

    const object = this.evaluate(target.object, env);
    if (target.type === "Member") {
      if (!(object instanceof Map)) {
        throw new RuntimeError(`can't set '.${target.name}' on ${typeName(object)}`, target.nameSpan);
      }
      const value = this.evaluate(valueExpr, env);
      const result = combine(object.get(target.name) ?? null, value);
      object.set(target.name, result);
      return result;
    }

    const key = this.evaluate(target.index, env);
    const value = this.evaluate(valueExpr, env);
    if (Array.isArray(object)) {
      const i = listIndex(object, key, target.index.span);
      return (object[i] = combine(object[i]!, value));
    }
    if (object instanceof Map) {
      const k = mapKey(key, target.index.span);
      const result = combine(object.get(k) ?? null, value);
      object.set(k, result);
      return result;
    }
    if (typeof object === "string") {
      throw new RuntimeError("strings can't be changed in place", target.span, "build a new string instead");
    }
    throw new RuntimeError(`can't index into ${typeName(object)}`, target.object.span);
  }

  private index(object: Value, key: Value, span: Span): Value {
    if (Array.isArray(object)) return object[listIndex(object, key, span)]!;
    if (typeof object === "string") {
      const chars = object;
      return chars[listIndex(chars, key, span)]!;
    }
    if (object instanceof Map) return object.get(mapKey(key, span)) ?? null;
    throw new RuntimeError(`can't index into ${typeName(object)}`, span);
  }

  private binary(op: BinaryOp, a: Value, b: Value, span: Span): Value {
    switch (op) {
      case "==":
        return equals(a, b);
      case "!=":
        return !equals(a, b);
      case "+":
        if (typeof a === "number" && typeof b === "number") return a + b;
        if (typeof a === "string" && typeof b === "string") return a + b;
        if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
        throw new RuntimeError(`can't add ${typeName(a)} and ${typeName(b)}`, span,
          typeof a === "string" || typeof b === "string" ? 'convert with str(), or use "${...}" in a string' : undefined);
      case "*":
        if (typeof a === "string" && typeof b === "number" && Number.isInteger(b) && b >= 0) return a.repeat(b);
        break;
      case "<":
      case "<=":
      case ">":
      case ">=":
        if ((typeof a === "number" && typeof b === "number") || (typeof a === "string" && typeof b === "string")) {
          return op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : a >= b;
        }
        throw new RuntimeError(`can't compare ${typeName(a)} with ${typeName(b)}`, span);
      default:
        break;
    }
    if (typeof a !== "number" || typeof b !== "number") {
      throw new RuntimeError(`'${op}' needs two numbers, got ${typeName(a)} and ${typeName(b)}`, span);
    }
    switch (op) {
      case "-":
        return a - b;
      case "*":
        return a * b;
      case "/":
        if (b === 0) throw new RuntimeError("division by zero", span);
        return a / b;
      case "%":
        if (b === 0) throw new RuntimeError("modulo by zero", span);
        return a - b * Math.floor(a / b); // floored, so -7 % 3 is 2, as in Python
      default:
        return a ** b;
    }
  }

  // ---- calls ---------------------------------------------------------------------------------------------------

  private callValue(callee: Value, args: Value[], span: Span, calleeSpan: Span = span): Value {
    if (callee instanceof Closure) return this.callClosure(callee, args, span);
    if (callee instanceof Builtin) return this.callBuiltin(callee, args, span);
    throw new RuntimeError(`${typeName(callee)} is not a function`, calleeSpan,
      callee === null ? "check the name: this variable is nil" : undefined);
  }

  private callClosure(closure: Closure, args: Value[], span: Span): Value {
    const fn: FunctionExpr = closure.fn;
    if (args.length !== fn.params.length) {
      throw new RuntimeError(`${closure.name}() takes ${plural(fn.params.length, "argument")}, got ${args.length}`, span);
    }
    if (this.callDepth >= this.maxCallDepth) {
      throw new RuntimeError(`stack overflow: more than ${this.maxCallDepth} nested calls`, span,
        "check that the recursion has a base case");
    }
    const env = new Env(fn.scopeSize!, closure.env);
    for (let i = 0; i < args.length; i++) env.slots[i] = args[i]!;
    this.tick();
    this.callDepth++;
    try {
      if (!Array.isArray(fn.body)) return this.evaluate(fn.body, env);
      const completion = this.executeBlock(fn.body, env);
      return completion instanceof ReturnValue ? completion.value : null;
    } catch (e) {
      if (e instanceof RangeError) {
        // The JavaScript stack ran out before our own limit did.
        throw new RuntimeError("stack overflow: too many nested calls", span, "check that the recursion has a base case");
      }
      if (e instanceof RuntimeError) {
        e.trace.push({ name: closure.name, span: pendingSpan(e) });
        setPendingSpan(e, span);
      }
      throw e;
    } finally {
      this.callDepth--;
    }
  }

  private tick(): void {
    if (this.heartbeat && (++this.ticks & 1023) === 0) this.heartbeat();
  }

  private callBuiltin(builtin: Builtin, args: Value[], span: Span): Value {
    if (args.length < builtin.minArgs || args.length > builtin.maxArgs) {
      const expected = builtin.minArgs === builtin.maxArgs
        ? plural(builtin.minArgs, "argument")
        : builtin.maxArgs === Infinity
          ? `at least ${plural(builtin.minArgs, "argument")}`
          : `${builtin.minArgs} to ${builtin.maxArgs} arguments`;
      throw new RuntimeError(`${builtin.name}() takes ${expected}, got ${args.length}`, span);
    }
    const saved = this.nativeCallSpan;
    this.nativeCallSpan = span;
    try {
      return builtin.impl(args, this.context);
    } catch (e) {
      if (e instanceof NativeError) throw new RuntimeError(e.message, span, e.hint);
      throw e;
    } finally {
      this.nativeCallSpan = saved;
    }
  }
}

// ---- helpers -------------------------------------------------------------------------------------------------

function scopeAt(env: Env, binding: Binding): Env {
  let scope = env;
  for (let d = binding.depth; d > 0; d--) scope = scope.parent!;
  return scope;
}

/** Validates a list (or string) index; negative indexes count from the end. */
function listIndex(items: { length: number }, key: Value, span: Span): number {
  if (typeof key !== "number" || !Number.isInteger(key)) {
    throw new RuntimeError(`list index must be a whole number, got ${typeof key === "number" ? key : typeName(key)}`, span);
  }
  const i = key < 0 ? items.length + key : key;
  if (i < 0 || i >= items.length) {
    throw new RuntimeError(`index ${key} is out of range for length ${items.length}`, span,
      items.length === 0 ? "it is empty" : `valid indexes are 0 to ${items.length - 1}, or -1 to -${items.length}`);
  }
  return i;
}

function mapKey(key: Value, span: Span): string {
  if (typeof key !== "string") {
    throw new RuntimeError(`map keys are strings, got ${typeName(key)}`, span, "convert it with str()");
  }
  return key;
}

function memberHint(object: Value, name: string): string | undefined {
  if ((Array.isArray(object) || typeof object === "string") && ["length", "len", "size", "count"].includes(name)) {
    return "use len(...)";
  }
  if (Array.isArray(object) || typeof object === "string") return `use ${name}(value, ...) instead of value.${name}(...)`;
  return undefined;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** While a runtime error unwinds, where the next outer frame was executing: initially the error itself. */
const pendingSpans = new WeakMap<RuntimeError, Span>();

function pendingSpan(e: RuntimeError): Span {
  return pendingSpans.get(e) ?? e.span;
}

function setPendingSpan(e: RuntimeError, span: Span): void {
  pendingSpans.set(e, span);
}
