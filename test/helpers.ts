import assert from "node:assert/strict";

import { check, run, SourceFile, type Diagnostic } from "../src/index.js";

/** Runs a program that must succeed and returns what it printed. */
export function output(code: string): string[] {
  const result = run(code);
  assert.deepEqual(result.errors, [], `expected no errors, got:\n${result.errors.join("\n")}`);
  return result.output;
}

/** Runs a program and returns its single printed line. */
export function printed(code: string): string {
  const lines = output(code);
  assert.equal(lines.length, 1, `expected one line of output, got ${JSON.stringify(lines)}`);
  return lines[0]!;
}

/** Evaluates one expression and returns how print shows it. */
export function evaluate(expression: string): string {
  return printed(`print(${expression})`);
}

/** Compile-time diagnostics (syntax and name errors) for a program. */
export function diagnostics(code: string): Diagnostic[] {
  return check(new SourceFile("test.fern", code)).diagnostics;
}

/** The message of the program's first error, compile-time or runtime. */
export function firstError(code: string): Diagnostic {
  const result = run(code);
  assert.ok(result.diagnostics.length > 0, "expected an error");
  return result.diagnostics[0]!;
}
