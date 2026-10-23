import type { Span } from "./source.js";

/**
 * Where a variable lives at runtime, computed by the resolver: `depth` scopes up from the current one, at slot
 * `index`. The interpreter follows this directly instead of searching scopes by name.
 */
export interface Binding {
  depth: number;
  index: number;
}

export type Expr =
  | { type: "Number"; value: number; span: Span }
  | { type: "String"; value: string; span: Span }
  | { type: "Template"; parts: (string | Expr)[]; span: Span }
  | { type: "Bool"; value: boolean; span: Span }
  | { type: "Nil"; span: Span }
  | Identifier
  | { type: "List"; items: Expr[]; span: Span }
  | { type: "Map"; entries: { key: string; keySpan: Span; value: Expr }[]; span: Span }
  | { type: "Unary"; op: "-" | "not"; operand: Expr; span: Span }
  | { type: "Binary"; op: BinaryOp; left: Expr; right: Expr; span: Span }
  | { type: "Logical"; op: "and" | "or"; left: Expr; right: Expr; span: Span }
  | { type: "Assign"; op: AssignOp; target: Identifier | IndexExpr | MemberExpr; value: Expr; span: Span }
  | { type: "Call"; callee: Expr; args: Expr[]; span: Span }
  | IndexExpr
  | MemberExpr
  | FunctionExpr;

export type BinaryOp = "+" | "-" | "*" | "/" | "%" | "**" | "==" | "!=" | "<" | "<=" | ">" | ">=";
export type AssignOp = "=" | "+=" | "-=" | "*=" | "/=" | "%=";

export interface Identifier {
  type: "Identifier";
  name: string;
  span: Span;
  binding?: Binding;
}

export interface IndexExpr {
  type: "Index";
  object: Expr;
  index: Expr;
  span: Span;
}

export interface MemberExpr {
  type: "Member";
  object: Expr;
  name: string;
  nameSpan: Span;
  span: Span;
}

export interface FunctionExpr {
  type: "Function";
  name: string;
  params: { name: string; span: Span }[];
  /** A block body, or a single expression for `fn(x) => x * 2`. */
  body: Stmt[] | Expr;
  span: Span;
  /** Slots the function's scope needs: its parameters plus the body's top-level declarations. */
  scopeSize?: number;
}

export type Stmt =
  | { type: "Let"; name: string; nameSpan: Span; init: Expr | null; constant: boolean; binding?: Binding; span: Span }
  | { type: "FnDecl"; name: string; nameSpan: Span; fn: FunctionExpr; binding?: Binding; span: Span }
  | { type: "Expr"; expr: Expr; span: Span }
  | Block
  | { type: "If"; cond: Expr; then: Block; else: Block | null; span: Span }
  | { type: "While"; cond: Expr; body: Block; span: Span }
  | { type: "For"; name: string; nameSpan: Span; iterable: Expr; body: Block; span: Span; scopeSize?: number }
  | { type: "Return"; value: Expr | null; span: Span }
  | { type: "Break"; span: Span }
  | { type: "Continue"; span: Span };

export interface Block {
  type: "Block";
  body: Stmt[];
  span: Span;
  /** Number of variables declared directly in the block; 0 means no runtime scope is created for it. */
  scopeSize?: number;
}

export interface Program {
  body: Stmt[];
  scopeSize?: number;
}
