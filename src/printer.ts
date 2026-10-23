import type { Block, Expr, Program, Stmt } from "./ast.js";

/**
 * Prints the AST as an indented S-expression. The playground's "AST" tab shows it, and the parser tests use it to
 * check precedence: `1 + 2 * 3` prints as `(+ 1 (* 2 3))`.
 */
export function printProgram(program: Program): string {
  return program.body.map((stmt) => printStmt(stmt, 0)).join("\n");
}

export function printExpr(expr: Expr): string {
  switch (expr.type) {
    case "Number":
      return String(expr.value);
    case "String":
      return JSON.stringify(expr.value);
    case "Template":
      return `(template ${expr.parts.map((p) => (typeof p === "string" ? JSON.stringify(p) : printExpr(p))).join(" ")})`;
    case "Bool":
      return String(expr.value);
    case "Nil":
      return "nil";
    case "Identifier":
      return expr.name;
    case "List":
      return `(list${expr.items.map((i) => " " + printExpr(i)).join("")})`;
    case "Map":
      return `(map${expr.entries.map((e) => ` (${e.key} ${printExpr(e.value)})`).join("")})`;
    case "Unary":
      return `(${expr.op} ${printExpr(expr.operand)})`;
    case "Binary":
    case "Logical":
      return `(${expr.op} ${printExpr(expr.left)} ${printExpr(expr.right)})`;
    case "Assign":
      return `(${expr.op} ${printExpr(expr.target)} ${printExpr(expr.value)})`;
    case "Call":
      return `(call ${printExpr(expr.callee)}${expr.args.map((a) => " " + printExpr(a)).join("")})`;
    case "Index":
      return `(index ${printExpr(expr.object)} ${printExpr(expr.index)})`;
    case "Member":
      return `(. ${printExpr(expr.object)} ${expr.name})`;
    case "Function": {
      const head = `(fn${expr.name ? " " + expr.name : ""} (${expr.params.map((p) => p.name).join(" ")})`;
      if (!Array.isArray(expr.body)) return `${head} ${printExpr(expr.body)})`;
      return `${head}${expr.body.map((s) => "\n" + printStmt(s, 1)).join("")})`;
    }
  }
}

function printStmt(stmt: Stmt, depth: number): string {
  const pad = "  ".repeat(depth);
  switch (stmt.type) {
    case "Let":
      return `${pad}(${stmt.constant ? "const" : "let"} ${stmt.name}${stmt.init ? " " + indentTail(printExpr(stmt.init), pad) : ""})`;
    case "FnDecl":
      return pad + indentTail(printExpr(stmt.fn), pad);
    case "Expr":
      return pad + indentTail(printExpr(stmt.expr), pad);
    case "Block":
      return `${pad}(block${printBody(stmt, depth)})`;
    case "If":
      return `${pad}(if ${printExpr(stmt.cond)}${printBody(stmt.then, depth)}${stmt.else ? `\n${pad}  else${printBody(stmt.else, depth + 1)}` : ""})`;
    case "While":
      return `${pad}(while ${printExpr(stmt.cond)}${printBody(stmt.body, depth)})`;
    case "For":
      return `${pad}(for ${stmt.name} ${printExpr(stmt.iterable)}${printBody(stmt.body, depth)})`;
    case "Return":
      return `${pad}(return${stmt.value ? " " + printExpr(stmt.value) : ""})`;
    case "Break":
      return `${pad}(break)`;
    case "Continue":
      return `${pad}(continue)`;
  }
}

function printBody(block: Block, depth: number): string {
  return block.body.map((s) => "\n" + printStmt(s, depth + 1)).join("");
}

/** Function bodies print on following lines; indent them to the statement's own depth. */
function indentTail(text: string, pad: string): string {
  return text.replace(/\n/g, "\n" + pad);
}
