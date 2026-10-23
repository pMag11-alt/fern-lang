import type { Program } from "./ast.js";
import { CompileError, formatDiagnostic, RuntimeError, type Diagnostic } from "./errors.js";
import { Interpreter, type InterpreterOptions } from "./interpreter.js";
import { parse } from "./parser.js";
import { Globals, resolve } from "./resolver.js";
import { SourceFile } from "./source.js";
import type { Value } from "./values.js";

export { tokenize } from "./lexer.js";
export { parse } from "./parser.js";
export { resolve, Globals } from "./resolver.js";
export { Interpreter } from "./interpreter.js";
export { printProgram, printExpr } from "./printer.js";
export { SourceFile } from "./source.js";
export { CompileError, RuntimeError, formatDiagnostic } from "./errors.js";
export type { Diagnostic, StackFrame } from "./errors.js";
export { show, repr, type Value } from "./values.js";
export { BUILTIN_NAMES } from "./builtins.js";

/**
 * Parses and resolves a program without running it. Returns the program and every syntax and name error, which is
 * what the playground uses to underline mistakes while you type.
 */
export function check(source: SourceFile, globals?: Globals): { program: Program; diagnostics: Diagnostic[] } {
  const { program, errors } = parse(source);
  // Resolving a program with syntax errors would only add noise, so stop there.
  const diagnostics = errors.length > 0 ? errors : resolve(program, globals);
  diagnostics.sort((a, b) => a.span.start - b.span.start);
  return { program, diagnostics };
}

/** Compiles a program, throwing {@link CompileError} if it has syntax or name errors. */
export function compile(source: SourceFile, globals?: Globals): Program {
  const { program, diagnostics } = check(source, globals);
  if (diagnostics.length > 0) throw new CompileError(diagnostics);
  return program;
}

export interface RunResult {
  ok: boolean;
  /** Printed lines. */
  output: string[];
  /** Formatted errors, ready to show. */
  errors: string[];
  diagnostics: Diagnostic[];
  milliseconds: number;
}

/** Compiles and runs source text, capturing output and errors instead of throwing. */
export function run(text: string, options: InterpreterOptions & { fileName?: string } = {}): RunResult {
  const source = new SourceFile(options.fileName ?? "main.fern", text);
  const output: string[] = [];
  const started = performance.now();
  const print = (line: string) => {
    output.push(line);
    options.print?.(line);
  };
  const finish = (diagnostics: Diagnostic[], errors: string[]): RunResult =>
    ({ ok: errors.length === 0, output, errors, diagnostics, milliseconds: performance.now() - started });
  try {
    const program = compile(source);
    new Interpreter({ ...options, print }).run(program);
    return finish([], []);
  } catch (e) {
    if (e instanceof CompileError) {
      return finish(e.diagnostics, e.diagnostics.map((d) => formatDiagnostic(d, source)));
    }
    if (e instanceof RuntimeError) {
      return finish([e.diagnostic], [formatDiagnostic(e.diagnostic, source, e.trace)]);
    }
    throw e;
  }
}

/** Runs one REPL entry against globals kept from earlier entries; returns the value of a trailing expression. */
export class Session {
  private readonly globals = new Globals(true);
  private readonly interpreter: Interpreter;

  constructor(options: InterpreterOptions = {}) {
    this.interpreter = new Interpreter(options);
  }

  evaluate(text: string, fileName = "<repl>"): { value: Value; source: SourceFile } {
    const source = new SourceFile(fileName, text);
    const saved = this.globals.snapshot();
    let program: Program;
    try {
      program = compile(source, this.globals);
    } catch (e) {
      this.globals.restore(saved);
      throw e;
    }
    return { value: this.interpreter.run(program), source };
  }
}
