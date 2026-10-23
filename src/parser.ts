import type { AssignOp, BinaryOp, Block, Expr, FunctionExpr, Program, Stmt } from "./ast.js";
import type { Diagnostic } from "./errors.js";
import { tokenize } from "./lexer.js";
import type { SourceFile, Span } from "./source.js";
import type { Token, TokenKind } from "./token.js";

export interface ParseResult {
  program: Program;
  errors: Diagnostic[];
}

/** Lexes and parses a whole program, collecting every syntax error instead of stopping at the first. */
export function parse(source: SourceFile): ParseResult {
  const lexed = tokenize(source);
  const parser = new Parser(source, lexed.tokens);
  const program = parser.parseProgram();
  return { program, errors: [...lexed.errors, ...parser.errors] };
}

/** Unwinds the parser to the start of the next statement after an error has been recorded. */
class ParseFailure extends Error {}

const STATEMENT_KEYWORDS: ReadonlySet<TokenKind> = new Set<TokenKind>(["let", "const", "fn", "if", "while", "for", "return"]);
const ASSIGN_OPS: ReadonlySet<TokenKind> = new Set<TokenKind>(["=", "+=", "-=", "*=", "/=", "%="]);

/**
 * A recursive-descent parser. Binary operators are parsed by precedence climbing, from loosest to tightest:
 *
 *   assignment  =  +=  -=  *=  /=  %=      (right-associative)
 *   pipeline    |>
 *   or, and
 *   equality    ==  !=
 *   comparison  <  <=  >  >=
 *   additive    +  -
 *   multiplicative  *  /  %
 *   unary       -  not  !
 *   power       **                         (right-associative, so -2 ** 2 is -4)
 *   postfix     call()  index[]  .member
 */
class Parser {
  readonly errors: Diagnostic[] = [];
  private pos = 0;
  /** Inside `if`, `while` and `for` headers a `{` opens the body, so it cannot also start a map literal. */
  private noMapLiteral = false;

  constructor(
    private readonly source: SourceFile,
    private readonly tokens: Token[],
  ) {}

  parseProgram(): Program {
    const body: Stmt[] = [];
    while (!this.check("eof")) {
      if (this.match(";")) continue;
      if (this.check("}")) {
        this.errors.push({ phase: "syntax", message: "unexpected '}'", span: this.peek().span, hint: "no block is open here" });
        this.advance();
        continue;
      }
      const stmt = this.statementSafely();
      if (stmt) body.push(stmt);
    }
    return { body };
  }

  // ---- statements ----------------------------------------------------------------------------------------------

  private statementSafely(): Stmt | null {
    const before = this.pos;
    try {
      return this.statement();
    } catch (e) {
      if (!(e instanceof ParseFailure)) throw e;
      this.synchronize();
      if (this.pos === before) this.advance();
      return null;
    }
  }

  private statement(): Stmt {
    switch (this.peek().kind) {
      case "let":
      case "const":
        return this.letStatement();
      case "fn":
        if (this.peekAt(1).kind === "identifier") return this.fnDeclaration();
        break;
      case "if":
        return this.ifStatement();
      case "while":
        return this.whileStatement();
      case "for":
        return this.forStatement();
      case "return":
        return this.returnStatement();
      case "break":
      case "continue": {
        const token = this.advance();
        this.terminator();
        return { type: token.kind === "break" ? "Break" : "Continue", span: token.span };
      }
      case "{":
        return this.block();
      default:
        break;
    }
    const expr = this.expression();
    this.terminator();
    return { type: "Expr", expr, span: expr.span };
  }

  private letStatement(): Stmt {
    const keyword = this.advance();
    const constant = keyword.kind === "const";
    const name = this.expect("identifier", `expected a variable name after '${keyword.kind}'`);
    let init: Expr | null = null;
    if (this.match("=")) {
      init = this.expression();
      if (init.type === "Function" && init.name === "") init.name = name.text;
    } else if (constant) {
      this.fail(`constant '${name.text}' needs a value`, name.span, `write: const ${name.text} = ...`);
    }
    this.terminator();
    return { type: "Let", name: name.text, nameSpan: name.span, init, constant, span: this.spanFrom(keyword.span) };
  }

  private fnDeclaration(): Stmt {
    const keyword = this.advance();
    const name = this.advance();
    const fn = this.functionRest(keyword, name.text);
    return { type: "FnDecl", name: name.text, nameSpan: name.span, fn, span: fn.span };
  }

  private ifStatement(): Stmt & { type: "If" } {
    const keyword = this.advance();
    const cond = this.condition();
    const then = this.block();
    let otherwise: Block | null = null;
    if (this.match("else")) {
      if (this.check("if")) {
        const nested = this.ifStatement();
        otherwise = { type: "Block", body: [nested], span: nested.span };
      } else {
        otherwise = this.block();
      }
    }
    return { type: "If", cond, then, else: otherwise, span: this.spanFrom(keyword.span) };
  }

  private whileStatement(): Stmt {
    const keyword = this.advance();
    const cond = this.condition();
    const body = this.block();
    return { type: "While", cond, body, span: this.spanFrom(keyword.span) };
  }

  private forStatement(): Stmt {
    const keyword = this.advance();
    const name = this.expect("identifier", "expected a loop variable after 'for'", "write: for item in list { ... }");
    this.expect("in", "expected 'in' after the loop variable", "write: for item in list { ... }");
    const iterable = this.condition();
    const body = this.block();
    return { type: "For", name: name.text, nameSpan: name.span, iterable, body, span: this.spanFrom(keyword.span) };
  }

  private returnStatement(): Stmt {
    const keyword = this.advance();
    const value = this.check(";") || this.check("}") || this.check("eof") ? null : this.expression();
    this.terminator();
    return { type: "Return", value, span: this.spanFrom(keyword.span) };
  }

  private block(): Block {
    const open = this.expect("{", "expected '{' to start a block");
    const saved = this.noMapLiteral;
    this.noMapLiteral = false;
    const body: Stmt[] = [];
    while (!this.check("}") && !this.check("eof")) {
      if (this.match(";")) continue;
      const stmt = this.statementSafely();
      if (stmt) body.push(stmt);
    }
    this.noMapLiteral = saved;
    if (this.check("eof")) {
      this.fail("this '{' is never closed", open.span, "add a matching '}'");
    }
    const close = this.advance();
    return { type: "Block", body, span: { start: open.span.start, end: close.span.end } };
  }

  /** A statement ends at a semicolon (typed or inserted at a line break), a closing brace, or the end of input. */
  private terminator(): void {
    if (this.match(";") || this.check("}") || this.check("eof")) return;
    this.fail(`expected the statement to end before ${describe(this.peek())}`, this.peek().span,
      "put the next statement on its own line, or separate them with ';'");
  }

  private condition(): Expr {
    const saved = this.noMapLiteral;
    this.noMapLiteral = true;
    try {
      return this.expression();
    } finally {
      this.noMapLiteral = saved;
    }
  }

  // ---- expressions ---------------------------------------------------------------------------------------------

  private expression(): Expr {
    return this.assignment();
  }

  private assignment(): Expr {
    const target = this.pipeline();
    if (!ASSIGN_OPS.has(this.peek().kind)) return target;
    const op = this.advance().kind as AssignOp;
    const value = this.assignment();
    if (target.type !== "Identifier" && target.type !== "Index" && target.type !== "Member") {
      this.fail("can't assign to this", target.span, "only variables, list[index] and map.key can be assigned");
    }
    return { type: "Assign", op, target, value, span: cover(target.span, value.span) };
  }

  /** `x |> f(a)` becomes `f(x, a)`, and `x |> f` becomes `f(x)`. */
  private pipeline(): Expr {
    let left = this.or();
    while (this.match("|>")) {
      const right = this.or();
      left = right.type === "Call"
        ? { ...right, args: [left, ...right.args], span: cover(left.span, right.span) }
        : { type: "Call", callee: right, args: [left], span: cover(left.span, right.span) };
    }
    return left;
  }

  private or(): Expr {
    let left = this.and();
    while (this.match("or")) {
      const right = this.and();
      left = { type: "Logical", op: "or", left, right, span: cover(left.span, right.span) };
    }
    return left;
  }

  private and(): Expr {
    let left = this.binary(0);
    while (this.match("and")) {
      const right = this.binary(0);
      left = { type: "Logical", op: "and", left, right, span: cover(left.span, right.span) };
    }
    return left;
  }

  private static readonly LEVELS: BinaryOp[][] = [["==", "!="], ["<", "<=", ">", ">="], ["+", "-"], ["*", "/", "%"]];

  /** Left-associative binary operators, one precedence level per recursion depth. */
  private binary(level: number): Expr {
    if (level === Parser.LEVELS.length) return this.unary();
    let left = this.binary(level + 1);
    const ops = Parser.LEVELS[level]!;
    while ((ops as string[]).includes(this.peek().kind)) {
      const op = this.advance().kind as BinaryOp;
      const right = this.binary(level + 1);
      left = { type: "Binary", op, left, right, span: cover(left.span, right.span) };
    }
    return left;
  }

  private unary(): Expr {
    if (this.check("-") || this.check("not") || this.check("!")) {
      const op = this.advance();
      const operand = this.unary();
      return { type: "Unary", op: op.kind === "-" ? "-" : "not", operand, span: cover(op.span, operand.span) };
    }
    return this.power();
  }

  private power(): Expr {
    const base = this.postfix();
    if (!this.match("**")) return base;
    const exponent = this.unary();
    return { type: "Binary", op: "**", left: base, right: exponent, span: cover(base.span, exponent.span) };
  }

  private postfix(): Expr {
    let expr = this.primary();
    for (;;) {
      if (this.check("(")) {
        const open = this.advance();
        const args = this.withMapLiterals(() => this.list(")", () => this.expression()));
        const close = this.expectClosing(")", open, "expected ')' after the arguments");
        expr = { type: "Call", callee: expr, args, span: cover(expr.span, close.span) };
      } else if (this.check("[")) {
        const open = this.advance();
        const index = this.withMapLiterals(() => this.expression());
        const close = this.expectClosing("]", open, "expected ']' after the index");
        expr = { type: "Index", object: expr, index, span: cover(expr.span, close.span) };
      } else if (this.match(".")) {
        const name = this.expect("identifier", "expected a name after '.'");
        expr = { type: "Member", object: expr, name: name.text, nameSpan: name.span, span: cover(expr.span, name.span) };
      } else {
        return expr;
      }
    }
  }

  private primary(): Expr {
    const token = this.peek();
    switch (token.kind) {
      case "number":
        this.advance();
        return { type: "Number", value: token.value as number, span: token.span };
      case "string":
        this.advance();
        return { type: "String", value: token.value as string, span: token.span };
      case "template":
        this.advance();
        return this.template(token);
      case "true":
      case "false":
        this.advance();
        return { type: "Bool", value: token.kind === "true", span: token.span };
      case "nil":
        this.advance();
        return { type: "Nil", span: token.span };
      case "identifier":
        this.advance();
        return { type: "Identifier", name: token.text, span: token.span };
      case "(": {
        this.advance();
        const inner = this.withMapLiterals(() => this.expression());
        this.expectClosing(")", token, "expected ')' to close the parenthesis");
        return inner;
      }
      case "[": {
        this.advance();
        const items = this.withMapLiterals(() => this.list("]", () => this.expression()));
        const close = this.expectClosing("]", token, "expected ']' to close the list");
        return { type: "List", items, span: cover(token.span, close.span) };
      }
      case "{":
        if (!this.noMapLiteral) return this.mapLiteral();
        this.fail("expected an expression, found '{'", token.span,
          "a map here would be confused with the block; wrap it in parentheses: ({...})");
      case "fn":
        this.advance();
        return this.functionRest(token, "");
      case "error":
        // The lexer has already reported this token.
        this.advance();
        throw new ParseFailure();
      default:
        break;
    }
    this.fail(`expected an expression, found ${describe(token)}`, token.span);
  }

  /** `{name: "Ada", "full name": "Ada Lovelace", age}`; a bare `age` is shorthand for `age: age`. */
  private mapLiteral(): Expr {
    const open = this.advance();
    const entries: { key: string; keySpan: Span; value: Expr }[] = [];
    this.skipVirtualSemicolons();
    while (!this.check("}") && !this.check("eof")) {
      const key = this.peek();
      if (key.kind !== "identifier" && key.kind !== "string") {
        this.fail(`expected a key, found ${describe(key)}`, key.span, "keys are names or strings: {name: 1, \"two words\": 2}");
      }
      this.advance();
      const keyName = key.kind === "string" ? (key.value as string) : key.text;
      let value: Expr;
      if (this.match(":")) {
        value = this.expression();
        if (value.type === "Function" && value.name === "") value.name = keyName;
      } else if (key.kind === "identifier") {
        value = { type: "Identifier", name: key.text, span: key.span };
      } else {
        this.fail("expected ':' after the key", this.peek().span);
      }
      entries.push({ key: keyName, keySpan: key.span, value });
      this.skipVirtualSemicolons();
      if (!this.match(",")) break;
      this.skipVirtualSemicolons();
    }
    const close = this.expectClosing("}", open, "expected '}' to close the map");
    return { type: "Map", entries, span: cover(open.span, close.span) };
  }

  /** `fn(a, b) { ... }` or `fn(x) => expression`, after the `fn` keyword (and name, for declarations). */
  private functionRest(keyword: Token, name: string): FunctionExpr {
    this.expect("(", name ? `expected '(' after the function name` : "expected '(' after 'fn'");
    const seen = new Set<string>();
    const params = this.list(")", () => {
      const param = this.expect("identifier", "expected a parameter name");
      if (seen.has(param.text)) {
        this.errors.push({ phase: "syntax", message: `duplicate parameter '${param.text}'`, span: param.span });
      }
      seen.add(param.text);
      return { name: param.text, span: param.span };
    });
    this.expect(")", "expected ')' after the parameters");
    if (this.match("=>")) {
      const saved = this.noMapLiteral;
      this.noMapLiteral = false;
      const body = this.expression();
      this.noMapLiteral = saved;
      return { type: "Function", name, params, body, span: cover(keyword.span, body.span) };
    }
    if (!this.check("{")) {
      this.fail(`expected '{' or '=>' to start the function body, found ${describe(this.peek())}`, this.peek().span);
    }
    const body = this.block();
    return { type: "Function", name, params, body: body.body, span: cover(keyword.span, body.span) };
  }

  /** Parses a string's `${...}` parts with a lexer limited to each part's source range, so spans stay exact. */
  private template(token: Token): Expr {
    const parts: (string | Expr)[] = [];
    for (const part of token.parts!) {
      if (part.kind === "text") {
        parts.push(part.value);
        continue;
      }
      const lexed = tokenize(this.source, part.span.start, part.span.end);
      this.errors.push(...lexed.errors);
      const inner = new Parser(this.source, lexed.tokens);
      if (inner.check("eof")) {
        this.errors.push({ phase: "syntax", message: "empty ${} in string", span: { start: part.span.start - 2, end: part.span.end + 1 } });
        continue;
      }
      try {
        parts.push(inner.expression());
        if (!inner.check("eof")) inner.fail(`unexpected ${describe(inner.peek())} in \${...}`, inner.peek().span);
      } catch (e) {
        if (!(e instanceof ParseFailure)) throw e;
      }
      this.errors.push(...inner.errors);
    }
    return { type: "Template", parts, span: token.span };
  }

  /** Comma-separated items up to (not including) `close`, allowing a trailing comma. */
  private list<T>(close: TokenKind, item: () => T): T[] {
    const items: T[] = [];
    while (!this.check(close) && !this.check("eof")) {
      items.push(item());
      if (!this.match(",")) break;
    }
    return items;
  }

  private withMapLiterals<T>(parse: () => T): T {
    const saved = this.noMapLiteral;
    this.noMapLiteral = false;
    try {
      return parse();
    } finally {
      this.noMapLiteral = saved;
    }
  }

  // ---- token helpers -------------------------------------------------------------------------------------------

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private peekAt(offset: number): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!;
  }

  private check(kind: TokenKind): boolean {
    return this.peek().kind === kind;
  }

  private match(kind: TokenKind): boolean {
    if (!this.check(kind)) return false;
    this.advance();
    return true;
  }

  private advance(): Token {
    const token = this.peek();
    if (token.kind !== "eof") this.pos++;
    return token;
  }

  private expect(kind: TokenKind, message: string, hint?: string): Token {
    if (this.check(kind)) return this.advance();
    return this.fail(`${message}, found ${describe(this.peek())}`, this.peek().span, hint);
  }

  /** Like {@link expect}, but also points at the opening bracket, which is usually where the mistake is. */
  private expectClosing(kind: ")" | "]" | "}", open: Token, message: string): Token {
    if (this.check(kind)) return this.advance();
    this.errors.push({
      phase: "syntax",
      message: `${message}, found ${describe(this.peek())}`,
      span: this.peek().span,
      note: { message: `the '${open.text}' was opened here`, span: open.span },
    });
    throw new ParseFailure();
  }

  private skipVirtualSemicolons(): void {
    while (this.check(";") && this.peek().virtual) this.advance();
  }

  private fail(message: string, span: Span, hint?: string): never {
    this.errors.push({ phase: "syntax", message, span, ...(hint ? { hint } : {}) });
    throw new ParseFailure();
  }

  /** Skips to a likely statement boundary so one mistake does not cause a cascade of errors. */
  private synchronize(): void {
    while (!this.check("eof")) {
      if (this.match(";")) return;
      if (STATEMENT_KEYWORDS.has(this.peek().kind) || this.check("}")) return;
      this.advance();
    }
  }

  private spanFrom(start: Span): Span {
    const previous = this.tokens[Math.max(0, this.pos - 1)]!;
    return { start: start.start, end: Math.max(start.end, previous.span.end) };
  }
}

function cover(a: Span, b: Span): Span {
  return { start: a.start, end: b.end };
}

function describe(token: Token): string {
  if (token.kind === "eof") return "the end of the file";
  if (token.kind === ";" && token.virtual) return "the end of the line";
  return `'${token.text}'`;
}
