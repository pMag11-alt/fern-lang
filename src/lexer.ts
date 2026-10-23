import type { Diagnostic } from "./errors.js";
import type { SourceFile, Span } from "./source.js";
import { isKeyword, PUNCTUATION, type TemplatePart, type Token, type TokenKind } from "./token.js";

export interface LexResult {
  tokens: Token[];
  errors: Diagnostic[];
}

/** Tokens after which a line break ends the statement (Go's rule, slightly extended). */
const ENDS_STATEMENT: ReadonlySet<TokenKind> = new Set<TokenKind>([
  "identifier", "number", "string", "template", "true", "false", "nil",
  ")", "]", "}", "return", "break", "continue",
]);

/** A line starting with one of these continues the previous line, so pipelines can be split across lines. */
const CONTINUATION = /^(\|>|\.|else\b|and\b|or\b)/;

/** Keywords that can only start a statement, never appear inside brackets. */
const STATEMENT_START = /^(let|const|if|while|for|return)\b/;

/**
 * Turns source text into tokens. Lexing never stops at the first problem: bad characters become error tokens and
 * are reported together, and the playground uses the same token stream for syntax highlighting.
 *
 * Semicolons are optional. As in Go, the lexer inserts one at a line break when the line could end a statement.
 * Unlike Go, it skips this inside `(` and `[`, and when the next line starts with `|>`, `.`, `else`, `and` or `or`.
 */
export function tokenize(source: SourceFile, start = 0, end = source.text.length): LexResult {
  return new Lexer(source, start, end).run();
}

class Lexer {
  private pos: number;
  private readonly tokens: Token[] = [];
  private readonly errors: Diagnostic[] = [];
  private readonly brackets: string[] = [];

  constructor(
    private readonly source: SourceFile,
    start: number,
    private readonly end: number,
  ) {
    this.pos = start;
  }

  run(): LexResult {
    for (;;) {
      this.skipWhitespace();
      if (this.pos >= this.end) {
        this.tokens.push({ kind: "eof", text: "", span: { start: this.end, end: this.end } });
        return { tokens: this.tokens, errors: this.errors };
      }
      this.scanToken();
    }
  }

  private get text(): string {
    return this.source.text;
  }

  private skipWhitespace(): void {
    while (this.pos < this.end) {
      const ch = this.text[this.pos]!;
      if (ch === "\n") {
        if (this.lineEndsStatement()) {
          this.tokens.push({ kind: ";", text: "", span: { start: this.pos, end: this.pos }, virtual: true });
        }
        this.pos++;
      } else if (ch === " " || ch === "\t" || ch === "\r") {
        this.pos++;
      } else if (ch === "/" && this.text[this.pos + 1] === "/") {
        while (this.pos < this.end && this.text[this.pos] !== "\n") this.pos++;
      } else {
        return;
      }
    }
  }

  private lineEndsStatement(): boolean {
    const last = this.tokens[this.tokens.length - 1];
    if (!last || !ENDS_STATEMENT.has(last.kind)) return false;
    const next = this.nextLineStart();
    const open = this.brackets[this.brackets.length - 1];
    if (open === "(" || open === "[") {
      // A statement keyword can't appear directly inside ( or [, so the bracket was never closed. End the statement
      // here and forget the bracket; otherwise one missing ']' would swallow every line break in the file.
      if (!STATEMENT_START.test(next)) return false;
      while (this.brackets.length > 0 && this.brackets[this.brackets.length - 1] !== "{") this.brackets.pop();
    }
    return !CONTINUATION.test(next);
  }

  /** The text where the next token after this line break starts, skipping blank lines and comments. */
  private nextLineStart(): string {
    let i = this.pos + 1;
    for (;;) {
      while (i < this.end && /\s/.test(this.text[i]!)) i++;
      if (this.text.startsWith("//", i)) {
        while (i < this.end && this.text[i] !== "\n") i++;
        continue;
      }
      return this.text.slice(i, Math.min(i + 8, this.end));
    }
  }

  private scanToken(): void {
    const start = this.pos;
    const ch = this.text[start]!;

    if (isDigit(ch)) return this.scanNumber();
    if (isIdentStart(ch)) return this.scanWord();
    if (ch === '"') return this.scanString();

    for (const p of PUNCTUATION) {
      if (this.text.startsWith(p, start)) {
        this.pos += p.length;
        this.trackBrackets(p);
        this.push(p, start);
        return;
      }
    }

    this.pos++;
    this.error(`unexpected character '${ch}'`, { start, end: this.pos });
    this.push("error", start);
  }

  private trackBrackets(p: string): void {
    if (p === "(" || p === "[" || p === "{") {
      this.brackets.push(p);
    } else if (p === ")" || p === "]" || p === "}") {
      this.brackets.pop();
    }
  }

  /** 42, 3.14, 1_000_000, 6.02e23 */
  private scanNumber(): void {
    const start = this.pos;
    const digits = () => {
      while (this.pos < this.end && (isDigit(this.text[this.pos]!) || this.text[this.pos] === "_")) this.pos++;
    };
    digits();
    if (this.text[this.pos] === "." && isDigit(this.text[this.pos + 1] ?? "")) {
      this.pos++;
      digits();
    }
    if (/[eE]/.test(this.text[this.pos] ?? "") && /[0-9+-]/.test(this.text[this.pos + 1] ?? "")) {
      this.pos += /[+-]/.test(this.text[this.pos + 1]!) ? 2 : 1;
      digits();
    }
    const text = this.text.slice(start, this.pos);
    const value = Number(text.replace(/_/g, ""));
    if (Number.isNaN(value) || text.endsWith("_")) {
      this.error(`invalid number '${text}'`, { start, end: this.pos });
    }
    this.tokens.push({ kind: "number", text, span: { start, end: this.pos }, value });
  }

  private scanWord(): void {
    const start = this.pos;
    while (this.pos < this.end && isIdentPart(this.text[this.pos]!)) this.pos++;
    const word = this.text.slice(start, this.pos);
    this.push(isKeyword(word) ? word : "identifier", start);
  }

  /**
   * "plain", "line\n", and "Hello, ${name}!". An interpolated string becomes a template token whose parts record the
   * source range of each embedded expression. The parser lexes and parses those ranges itself, so positions in error
   * messages stay exact.
   */
  private scanString(): void {
    const start = this.pos++;
    const parts: TemplatePart[] = [];
    let text = "";
    let interpolated = false;
    for (;;) {
      if (this.pos >= this.end) {
        this.error("unterminated string", { start, end: this.pos }, 'add a closing "');
        this.push("error", start);
        return;
      }
      const ch = this.text[this.pos]!;
      if (ch === '"') {
        this.pos++;
        break;
      }
      if (ch === "\\") {
        text += this.scanEscape();
      } else if (ch === "$" && this.text[this.pos + 1] === "{") {
        interpolated = true;
        if (text) parts.push({ kind: "text", value: text });
        text = "";
        const exprStart = this.pos + 2;
        const exprEnd = this.findInterpolationEnd(exprStart);
        if (exprEnd < 0) {
          this.error("unterminated '${' in string", { start: this.pos, end: this.pos + 2 }, "add a closing }");
          this.pos = this.end;
          this.push("error", start);
          return;
        }
        parts.push({ kind: "expr", span: { start: exprStart, end: exprEnd } });
        this.pos = exprEnd + 1;
      } else {
        text += ch;
        this.pos++;
      }
    }
    if (!interpolated) {
      this.tokens.push({ kind: "string", text: this.text.slice(start, this.pos), span: { start, end: this.pos }, value: text });
      return;
    }
    if (text) parts.push({ kind: "text", value: text });
    this.tokens.push({ kind: "template", text: this.text.slice(start, this.pos), span: { start, end: this.pos }, parts });
  }

  private scanEscape(): string {
    const start = this.pos;
    const ch = this.text[this.pos + 1];
    this.pos += 2;
    switch (ch) {
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      case "0": return "\0";
      case "\\": return "\\";
      case '"': return '"';
      case "$": return "$";
      case "u": {
        const match = /^\{([0-9a-fA-F]{1,6})\}/.exec(this.text.slice(this.pos, this.pos + 8));
        if (match) {
          const code = parseInt(match[1]!, 16);
          if (code <= 0x10ffff) {
            this.pos += match[0].length;
            return String.fromCodePoint(code);
          }
        }
        this.error("invalid unicode escape", { start, end: this.pos }, "write it as \\u{1F600}");
        return "";
      }
      default:
        this.error(`unknown escape sequence '\\${ch ?? ""}'`, { start, end: this.pos });
        return ch ?? "";
    }
  }

  /** Index of the `}` that closes an interpolation, skipping nested braces and strings; -1 if there is none. */
  private findInterpolationEnd(i: number): number {
    let depth = 1;
    while (i < this.end) {
      const ch = this.text[i];
      if (ch === '"') {
        i = this.skipNestedString(i);
        if (i < 0) return -1;
        continue;
      }
      if (ch === "{") depth++;
      if (ch === "}" && --depth === 0) return i;
      i++;
    }
    return -1;
  }

  private skipNestedString(i: number): number {
    i++;
    while (i < this.end) {
      const ch = this.text[i];
      if (ch === "\\") {
        i += 2;
      } else if (ch === '"') {
        return i + 1;
      } else if (ch === "$" && this.text[i + 1] === "{") {
        const close = this.findInterpolationEnd(i + 2);
        if (close < 0) return -1;
        i = close + 1;
      } else {
        i++;
      }
    }
    return -1;
  }

  private push(kind: TokenKind, start: number): void {
    this.tokens.push({ kind, text: this.text.slice(start, this.pos), span: { start, end: this.pos } });
  }

  private error(message: string, span: Span, hint?: string): void {
    this.errors.push({ phase: "syntax", message, span, ...(hint ? { hint } : {}) });
  }
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isIdentStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}
