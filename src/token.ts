import type { Span } from "./source.js";

export const KEYWORDS = [
  "let", "const", "fn", "return", "if", "else", "while", "for", "in",
  "break", "continue", "true", "false", "nil", "and", "or", "not",
] as const;

export type Keyword = (typeof KEYWORDS)[number];

/** Two-character operators are listed first so the lexer tries them before their one-character prefixes. */
export const PUNCTUATION = [
  "=>", "==", "!=", "<=", ">=", "|>", "**", "+=", "-=", "*=", "/=", "%=",
  "(", ")", "{", "}", "[", "]", ",", ".", ":", ";", "+", "-", "*", "/", "%", "=", "<", ">", "!",
] as const;

export type Punctuation = (typeof PUNCTUATION)[number];

export type TokenKind = "number" | "string" | "template" | "identifier" | "eof" | "error" | Keyword | Punctuation;

/** A piece of an interpolated string: literal text, or the source range of an embedded `${expression}`. */
export type TemplatePart = { kind: "text"; value: string } | { kind: "expr"; span: Span };

export interface Token {
  kind: TokenKind;
  /** The exact source text of the token. */
  text: string;
  span: Span;
  /** Numeric value of a number, or the unescaped value of a string. */
  value?: number | string;
  parts?: TemplatePart[];
  /** A semicolon inserted by the lexer at a line break, rather than typed. */
  virtual?: boolean;
}

const keywordSet: ReadonlySet<string> = new Set(KEYWORDS);

export function isKeyword(word: string): word is Keyword {
  return keywordSet.has(word);
}
