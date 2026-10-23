import type { Binding, Block, Expr, FunctionExpr, Identifier, Program, Stmt } from "./ast.js";
import { BUILTIN_NAMES } from "./builtins.js";
import type { Diagnostic } from "./errors.js";
import type { Span } from "./source.js";

type VarKind = "variable" | "constant" | "function" | "parameter" | "loop variable" | "built-in";

interface Variable {
  index: number;
  kind: VarKind;
  /** False between a `let` being hoisted and its initializer finishing. */
  initialized: boolean;
  span: Span | null;
}

class Scope {
  readonly vars = new Map<string, Variable>();

  constructor(
    /** How many functions enclose this scope; reads across a function boundary are checked at runtime instead. */
    readonly functionLevel: number,
    /** The REPL lets you redeclare a global by typing `let x = ...` again. */
    readonly allowRedeclare = false,
  ) {}

  get size(): number {
    return this.vars.size;
  }
}

/**
 * Global names that outlive a single `resolve` call, so each REPL line can see what earlier lines declared.
 */
export class Globals {
  readonly scope: Scope;

  /** @param repl allow `let x = ...` to redeclare an existing global, as typing it again in a REPL should */
  constructor(repl = false) {
    this.scope = new Scope(0, repl);
  }

  /** Saves the declared names, so a REPL entry that fails to compile leaves no half-declared variables behind. */
  snapshot(): GlobalsSnapshot {
    return new Map([...this.scope.vars].map(([name, variable]) => [name, { ...variable }]));
  }

  restore(snapshot: GlobalsSnapshot): void {
    this.scope.vars.clear();
    for (const [name, variable] of snapshot) this.scope.vars.set(name, variable);
  }
}

export type GlobalsSnapshot = ReadonlyMap<string, Variable>;

/**
 * The resolver runs after parsing and before execution. It works out, for every variable reference, which scope
 * declared it and at which slot. The interpreter can then read variables by index without searching scopes by
 * name. Along the way it reports mistakes that can be found without running the program:
 *
 * - undefined variables, with a "did you mean" suggestion
 * - assignment to a `const`, a function declaration or a built-in
 * - a name declared twice in the same scope
 * - using a variable before its `let` has run, when that is certain
 * - `return` outside a function, and `break` or `continue` outside a loop
 *
 * Declarations are hoisted to the top of their block, so functions can call each other in any order.
 */
export function resolve(program: Program, globals: Globals = new Globals()): Diagnostic[] {
  const resolver = new Resolver(globals);
  resolver.resolveProgram(program);
  return resolver.errors;
}

class Resolver {
  readonly errors: Diagnostic[] = [];
  private readonly scopes: Scope[];
  private functionLevel = 0;
  private loopDepth = 0;
  /** The variable whose `let` initializer is being resolved. */
  private initializing: Variable | null = null;

  constructor(private readonly globals: Globals) {
    const prelude = new Scope(0);
    BUILTIN_NAMES.forEach((name, index) => prelude.vars.set(name, { index, kind: "built-in", initialized: true, span: null }));
    this.scopes = [prelude, globals.scope];
  }

  resolveProgram(program: Program): void {
    this.hoist(program.body, this.globals.scope);
    this.statements(program.body);
    program.scopeSize = this.globals.scope.size;
  }

  // ---- statements ----------------------------------------------------------------------------------------------

  private statements(stmts: Stmt[]): void {
    for (const stmt of stmts) this.statement(stmt);
  }

  private statement(stmt: Stmt): void {
    switch (stmt.type) {
      case "Let": {
        const variable = this.current.vars.get(stmt.name)!;
        if (stmt.init) {
          this.initializing = variable;
          this.expression(stmt.init);
          this.initializing = null;
        }
        variable.initialized = true;
        stmt.binding = { depth: 0, index: variable.index };
        return;
      }
      case "FnDecl":
        stmt.binding = { depth: 0, index: this.current.vars.get(stmt.name)!.index };
        this.function(stmt.fn);
        return;
      case "Expr":
        this.expression(stmt.expr);
        return;
      case "Block":
        this.block(stmt);
        return;
      case "If":
        this.expression(stmt.cond);
        this.block(stmt.then);
        if (stmt.else) this.block(stmt.else);
        return;
      case "While":
        this.expression(stmt.cond);
        this.loopDepth++;
        this.block(stmt.body);
        this.loopDepth--;
        return;
      case "For": {
        this.expression(stmt.iterable);
        // One scope per iteration holds the loop variable and the body's own declarations, so closures created in
        // the loop each capture their own iteration's variable.
        const scope = this.push();
        scope.vars.set(stmt.name, { index: 0, kind: "loop variable", initialized: true, span: stmt.nameSpan });
        this.hoist(stmt.body.body, scope);
        this.loopDepth++;
        this.statements(stmt.body.body);
        this.loopDepth--;
        this.scopes.pop();
        stmt.scopeSize = scope.size;
        stmt.body.scopeSize = 0;
        return;
      }
      case "Return":
        if (this.functionLevel === 0) this.error("'return' outside a function", stmt.span);
        if (stmt.value) this.expression(stmt.value);
        return;
      case "Break":
      case "Continue":
        if (this.loopDepth === 0) this.error(`'${stmt.type.toLowerCase()}' outside a loop`, stmt.span);
        return;
    }
  }

  private block(block: Block): void {
    if (!declaresAnything(block.body)) {
      block.scopeSize = 0;
      this.statements(block.body);
      return;
    }
    const scope = this.push();
    this.hoist(block.body, scope);
    this.statements(block.body);
    this.scopes.pop();
    block.scopeSize = scope.size;
  }

  private function(fn: FunctionExpr): void {
    const savedLoopDepth = this.loopDepth;
    this.loopDepth = 0;
    this.functionLevel++;
    const scope = this.push();
    for (const param of fn.params) {
      if (!scope.vars.has(param.name)) {
        scope.vars.set(param.name, { index: scope.size, kind: "parameter", initialized: true, span: param.span });
      }
    }
    if (Array.isArray(fn.body)) {
      this.hoist(fn.body, scope);
      this.statements(fn.body);
    } else {
      this.expression(fn.body);
    }
    this.scopes.pop();
    fn.scopeSize = scope.size;
    this.functionLevel--;
    this.loopDepth = savedLoopDepth;
  }

  /** Declares a block's `let`, `const` and `fn` names before any of its statements run. */
  private hoist(stmts: Stmt[], scope: Scope): void {
    for (const stmt of stmts) {
      if (stmt.type !== "Let" && stmt.type !== "FnDecl") continue;
      const kind: VarKind = stmt.type === "FnDecl" ? "function" : stmt.constant ? "constant" : "variable";
      const existing = scope.vars.get(stmt.name);
      if (existing && !scope.allowRedeclare) {
        this.errors.push({
          phase: "name",
          message: `'${stmt.name}' is already declared in this scope`,
          span: stmt.nameSpan,
          hint: "use a different name, or assign with '=' instead",
          ...(existing.span ? { note: { message: `'${stmt.name}' was first declared here`, span: existing.span } } : {}),
        });
        continue;
      }
      scope.vars.set(stmt.name, {
        index: existing ? existing.index : scope.size,
        kind,
        // Functions are created when their block is entered, so they can be called before their declaration.
        initialized: stmt.type === "FnDecl" || (existing?.initialized ?? false),
        span: stmt.nameSpan,
      });
    }
  }

  // ---- expressions ---------------------------------------------------------------------------------------------

  private expression(expr: Expr): void {
    switch (expr.type) {
      case "Number":
      case "String":
      case "Bool":
      case "Nil":
        return;
      case "Template":
        for (const part of expr.parts) if (typeof part !== "string") this.expression(part);
        return;
      case "Identifier":
        this.reference(expr);
        return;
      case "List":
        expr.items.forEach((item) => this.expression(item));
        return;
      case "Map":
        expr.entries.forEach((entry) => this.expression(entry.value));
        return;
      case "Unary":
        this.expression(expr.operand);
        return;
      case "Binary":
      case "Logical":
        this.expression(expr.left);
        this.expression(expr.right);
        return;
      case "Assign":
        if (expr.target.type === "Identifier") {
          this.expression(expr.value);
          this.reference(expr.target, true);
        } else {
          this.expression(expr.target);
          this.expression(expr.value);
        }
        return;
      case "Call":
        this.expression(expr.callee);
        expr.args.forEach((arg) => this.expression(arg));
        return;
      case "Index":
        this.expression(expr.object);
        this.expression(expr.index);
        return;
      case "Member":
        this.expression(expr.object);
        return;
      case "Function":
        this.function(expr);
        return;
    }
  }

  private reference(id: Identifier, assigning = false): void {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const scope = this.scopes[i]!;
      const variable = scope.vars.get(id.name);
      if (!variable) continue;
      id.binding = { depth: this.scopes.length - 1 - i, index: variable.index } satisfies Binding;
      // Inside the same function, reading a hoisted `let` before it runs is always a mistake. From a nested function
      // it is fine as long as the function is called later, so that case is left to the runtime check.
      if (!variable.initialized && scope.functionLevel === this.functionLevel) {
        if (variable === this.initializing) {
          this.error(`can't use '${id.name}' in its own initializer`, id.span);
        } else {
          this.error(`can't use '${id.name}' before it is defined`, id.span, `move the 'let ${id.name}' above this line`);
        }
      }
      if (assigning && variable.kind !== "variable" && variable.kind !== "parameter" && variable.kind !== "loop variable") {
        this.errors.push({
          phase: "name",
          message: `can't assign to ${variable.kind} '${id.name}'`,
          span: id.span,
          ...(variable.kind === "constant" ? { hint: `declare it with 'let' instead of 'const' to allow changes` } : {}),
          ...(variable.span ? { note: { message: `'${id.name}' is declared here`, span: variable.span } } : {}),
        });
      }
      return;
    }
    this.errors.push({ phase: "name", message: `undefined variable '${id.name}'`, span: id.span, ...this.suggest(id.name) });
  }

  private suggest(name: string): { hint?: string } {
    const aliases: Record<string, string> = { null: "nil", None: "nil", undefined: "nil", True: "true", False: "false" };
    if (aliases[name]) return { hint: `Fern spells it '${aliases[name]}'` };
    let best: string | null = null;
    let bestDistance = name.length <= 4 ? 1 : 2;
    for (const scope of this.scopes) {
      for (const candidate of scope.vars.keys()) {
        const distance = editDistance(name, candidate);
        if (distance <= bestDistance && (best === null || distance < bestDistance)) {
          best = candidate;
          bestDistance = distance;
        }
      }
    }
    return best ? { hint: `did you mean '${best}'?` } : {};
  }

  private get current(): Scope {
    return this.scopes[this.scopes.length - 1]!;
  }

  private push(): Scope {
    const scope = new Scope(this.functionLevel);
    this.scopes.push(scope);
    return scope;
  }

  private error(message: string, span: Span, hint?: string): void {
    this.errors.push({ phase: "name", message, span, ...(hint ? { hint } : {}) });
  }
}

function declaresAnything(stmts: Stmt[]): boolean {
  return stmts.some((stmt) => stmt.type === "Let" || stmt.type === "FnDecl");
}

/** Levenshtein distance where swapping two adjacent letters counts as one edit ("cuont" → "count"). */
export function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return Infinity;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = best;
    }
  }
  return d[a.length]![b.length]!;
}
