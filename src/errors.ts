import type { SourceFile, Span } from "./source.js";

export type Phase = "syntax" | "name" | "runtime";

/** One problem in a program, pointing at the exact source range responsible. */
export interface Diagnostic {
  phase: Phase;
  message: string;
  span: Span;
  /** Shown under the caret, e.g. "did you mean 'count'?" */
  hint?: string;
  /** A second location, e.g. where a duplicate name was first declared. */
  note?: { message: string; span: Span };
}

/** A function call in progress when a runtime error happened, innermost first. */
export interface StackFrame {
  name: string;
  span: Span;
}

/** Thrown when a program cannot run: it carries every syntax and name error found, not just the first. */
export class CompileError extends Error {
  constructor(readonly diagnostics: Diagnostic[]) {
    super(diagnostics.map((d) => d.message).join("\n"));
    this.name = "CompileError";
  }
}

/** Thrown when a running program fails. {@link trace} is filled in as the error unwinds through calls. */
export class RuntimeError extends Error {
  readonly trace: StackFrame[] = [];

  constructor(
    message: string,
    readonly span: Span,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "RuntimeError";
  }

  get diagnostic(): Diagnostic {
    return { phase: "runtime", message: this.message, span: this.span, ...(this.hint ? { hint: this.hint } : {}) };
  }
}

const TITLES: Record<Phase, string> = {
  syntax: "syntax error",
  name: "error",
  runtime: "runtime error",
};

/**
 * Renders a diagnostic the way modern compilers do, with the offending code underlined:
 *
 *   error: undefined variable 'cuont'
 *    --> main.fern:3:7
 *     |
 *   3 | print(cuont)
 *     |       ^^^^^ did you mean 'count'?
 */
export function formatDiagnostic(d: Diagnostic, source: SourceFile, trace: StackFrame[] = []): string {
  const lines = [`${TITLES[d.phase]}: ${d.message}`, ...excerpt(source, d.span, d.hint)];
  if (d.note) {
    lines.push(`note: ${d.note.message}`, ...excerpt(source, d.note.span));
  }
  if (trace.length > 0) {
    lines.push("stack trace:");
    // Deep recursion produces thousands of identical frames; keep the innermost few and the outermost one.
    const shown = trace.length > 12 ? [...trace.slice(0, 10), null, trace[trace.length - 1]!] : trace;
    for (const frame of shown) {
      if (frame === null) {
        lines.push(`  ... ${trace.length - 11} more`);
        continue;
      }
      const { line, col } = source.position(frame.span.start);
      lines.push(`  at ${frame.name} (${source.name}:${line}:${col})`);
    }
  }
  return lines.join("\n");
}

function excerpt(source: SourceFile, span: Span, hint?: string): string[] {
  const { line, col } = source.position(span.start);
  const text = source.lineText(line);
  const gutter = " ".repeat(String(line).length);
  // Underline the span, but only up to the end of its first line.
  const width = Math.max(1, Math.min(span.end - span.start, text.length - col + 1));
  const underline = " ".repeat(col - 1) + "^".repeat(width) + (hint ? ` ${hint}` : "");
  return [`${gutter}--> ${source.name}:${line}:${col}`, `${gutter} |`, `${line} | ${text}`, `${gutter} | ${underline}`];
}
