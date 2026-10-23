import { BUILTIN_NAMES, SourceFile, tokenize, type Diagnostic } from "../src/index.js";
import type { Token } from "../src/token.js";

const KEYWORDS = new Set(["let", "const", "fn", "return", "if", "else", "while", "for", "in", "break", "continue", "and", "or", "not"]);
const LITERALS = new Set(["true", "false", "nil"]);
const BRACKETS = new Set(["(", ")", "[", "]", "{", "}", ",", ";", ":", "."]);
const BUILTINS = new Set(BUILTIN_NAMES);

/**
 * Turns source code into highlighted HTML using Fern's own lexer, so the colours always agree with what the
 * interpreter sees. Ranges with errors are wrapped in `.bad`, which draws a squiggly underline.
 *
 * Every character gets a class; runs of equal classes then become one span. Comments never become tokens, so they
 * are found in the gaps between tokens.
 */
export function highlight(code: string, diagnostics: readonly Diagnostic[] = []): string {
  const source = new SourceFile("main.fern", code);
  const classes = new Array<string>(code.length).fill("");
  const tokens = tokenize(source).tokens;

  let gapStart = 0;
  tokens.forEach((token, i) => {
    markComments(code, classes, gapStart, token.span.start);
    gapStart = token.span.end;
    if (token.kind === "template") {
      markTemplate(source, token, classes);
    } else {
      paint(classes, token.span.start, token.span.end, classify(token, tokens[i - 1], nextReal(tokens, i)));
    }
  });

  const bad = new Uint8Array(code.length + 1);
  for (const d of diagnostics) {
    const end = Math.max(d.span.end, d.span.start + 1);
    for (let i = d.span.start; i < Math.min(end, code.length + 1); i++) bad[i] = 1;
  }

  let html = "";
  let i = 0;
  while (i < code.length) {
    let j = i + 1;
    while (j < code.length && classes[j] === classes[i] && bad[j] === bad[i]) j++;
    const cls = [classes[i], bad[i] ? "bad" : ""].filter(Boolean).join(" ");
    const text = escapeHtml(code.slice(i, j));
    html += cls ? `<span class="${cls}">${text}</span>` : text;
    i = j;
  }
  // An error at the very end of the file (say, a missing '}') still needs something visible to underline.
  if (bad[code.length]) html += '<span class="bad"> </span>';
  // A trailing newline in a <pre> collapses; add a space so the overlay stays as tall as the textarea.
  return html + "\n ";
}

function classify(token: Token, previous: Token | undefined, next: Token | undefined): string {
  if (token.kind === "identifier") {
    if (previous?.kind === "fn") return "def";
    if (previous?.kind === ".") return "prop";
    if (next?.kind === ":") return "prop";
    if (next?.kind === "(") return BUILTINS.has(token.text) ? "builtin" : "call";
    return BUILTINS.has(token.text) ? "builtin" : "";
  }
  if (token.kind === "number") return "num";
  if (token.kind === "string") return "str";
  if (token.kind === "error") return "err";
  if (KEYWORDS.has(token.kind)) return "kw";
  if (LITERALS.has(token.kind)) return "lit";
  if (BRACKETS.has(token.kind)) return "punct";
  return token.virtual ? "" : "op";
}

/** Highlights a string's text, then the code inside each `${...}` with normal colours. */
function markTemplate(source: SourceFile, token: Token, classes: string[]): void {
  paint(classes, token.span.start, token.span.end, "str");
  for (const part of token.parts ?? []) {
    if (part.kind !== "expr") continue;
    paint(classes, part.span.start - 2, part.span.start, "interp");
    paint(classes, part.span.end, part.span.end + 1, "interp");
    paint(classes, part.span.start, part.span.end, "");
    const inner = tokenize(source, part.span.start, part.span.end).tokens;
    inner.forEach((t, i) => paint(classes, t.span.start, t.span.end, classify(t, inner[i - 1], nextReal(inner, i))));
  }
}

function markComments(code: string, classes: string[], from: number, to: number): void {
  let i = code.indexOf("//", from);
  while (i >= 0 && i < to) {
    const end = code.indexOf("\n", i);
    const stop = end < 0 || end > to ? to : end;
    paint(classes, i, stop, "comment");
    i = code.indexOf("//", stop);
  }
}

function nextReal(tokens: Token[], i: number): Token | undefined {
  for (let j = i + 1; j < tokens.length; j++) if (!tokens[j]!.virtual) return tokens[j];
  return undefined;
}

function paint(classes: string[], start: number, end: number, cls: string): void {
  for (let i = start; i < end && i < classes.length; i++) classes[i] = cls;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
