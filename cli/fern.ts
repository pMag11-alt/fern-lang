#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";

import {
  CompileError, formatDiagnostic, printProgram, repr, RuntimeError, Session, SourceFile, check, run, tokenize,
} from "../src/index.js";

const VERSION = "1.0.0";
const USAGE = `Fern ${VERSION}

Usage:
  fern                  start the interactive REPL
  fern <file.fern>      run a program
  fern --tokens <file>  print the tokens the lexer produces
  fern --ast <file>     print the syntax tree
  fern --version
`;

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);

/** Colours a formatted diagnostic: the headline and carets in red, the location gutter in blue. */
function colorize(message: string): string {
  return message
    .split("\n")
    .map((line, i) => {
      if (i === 0 || /^(syntax |runtime )?error:/.test(line)) return paint("1;31", line);
      if (line.startsWith("note:") || line === "stack trace:") return paint("1;36", line);
      const caret = /^(\s*\|\s*)(\s*)(\^+)(.*)$/.exec(line);
      if (caret) return paint("34", caret[1]!) + caret[2] + paint("1;31", caret[3]!) + paint("33", caret[4]!);
      if (/^\s*(-->|\d* \|)/.test(line)) return line.replace(/^(\s*(-->|\d* \|))/, (m) => paint("34", m));
      return line;
    })
    .join("\n");
}

function readSource(path: string): SourceFile {
  try {
    return new SourceFile(basename(path), readFileSync(path, "utf8"));
  } catch {
    console.error(`fern: can't read ${path}`);
    process.exit(2);
  }
}

function runFile(path: string): void {
  const source = readSource(path);
  const result = run(source.text, { fileName: source.name, print: (line) => console.log(line) });
  for (const error of result.errors) console.error(colorize(error) + "\n");
  process.exitCode = result.ok ? 0 : 1;
}

function printTokens(path: string): void {
  const source = readSource(path);
  for (const token of tokenize(source).tokens) {
    const { line, col } = source.position(token.span.start);
    const text = token.virtual ? "(newline)" : JSON.stringify(token.text);
    console.log(`${String(line).padStart(4)}:${String(col).padEnd(4)} ${token.kind.padEnd(11)} ${text}`);
  }
}

function printAst(path: string): void {
  const source = readSource(path);
  const { program, diagnostics } = check(source);
  console.log(printProgram(program));
  for (const d of diagnostics) console.error("\n" + colorize(formatDiagnostic(d, source)));
  process.exitCode = diagnostics.length > 0 ? 1 : 0;
}

/** Counts unclosed brackets, so the REPL can wait for the rest of a multi-line function or list. */
function openBrackets(text: string): number {
  let depth = 0;
  for (const token of tokenize(new SourceFile("<repl>", text)).tokens) {
    if (token.kind === "(" || token.kind === "[" || token.kind === "{") depth++;
    if (token.kind === ")" || token.kind === "]" || token.kind === "}") depth--;
  }
  return depth;
}

function repl(): void {
  console.log(`Fern ${VERSION} REPL. Type .help for help, .exit or Ctrl+D to quit.`);
  const session = new Session({ print: (line) => console.log(line) });
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: paint("32", "fern> ") });
  let buffer = "";

  rl.on("line", (line) => {
    if (buffer === "" && line.trim().startsWith(".")) {
      const command = line.trim();
      if (command === ".exit") return rl.close();
      if (command === ".help") {
        console.log("Enter Fern code. Unclosed brackets continue on the next line.");
        console.log("Examples:  let xs = range(5)   xs |> map(fn(x) => x * x)   fn sq(x) => x * x");
        console.log("Commands:  .help  .exit");
      } else {
        console.log(`unknown command ${command}`);
      }
      return rl.prompt();
    }
    buffer += (buffer ? "\n" : "") + line;
    if (openBrackets(buffer) > 0) {
      rl.setPrompt(paint("32", "....> "));
      return rl.prompt();
    }
    const input = buffer;
    buffer = "";
    rl.setPrompt(paint("32", "fern> "));
    if (input.trim() !== "") evaluate(session, input);
    rl.prompt();
  });
  rl.on("close", () => {
    console.log();
    process.exit(0);
  });
  rl.prompt();
}

function evaluate(session: Session, input: string): void {
  try {
    const { value } = session.evaluate(input);
    if (value !== null) console.log(paint("90", repr(value)));
  } catch (e) {
    const source = new SourceFile("<repl>", input);
    if (e instanceof CompileError) {
      for (const d of e.diagnostics) console.error(colorize(formatDiagnostic(d, source)));
    } else if (e instanceof RuntimeError) {
      console.error(colorize(formatDiagnostic(e.diagnostic, source, e.trace)));
    } else {
      throw e;
    }
  }
}

const args = process.argv.slice(2);
if (args.length === 0) {
  repl();
} else if (args[0] === "--help" || args[0] === "-h") {
  console.log(USAGE);
} else if (args[0] === "--version") {
  console.log(VERSION);
} else if ((args[0] === "--tokens" || args[0] === "--ast") && args[1]) {
  (args[0] === "--tokens" ? printTokens : printAst)(args[1]);
} else if (args.length === 1 && !args[0]!.startsWith("-")) {
  runFile(args[0]!);
} else {
  console.error(USAGE);
  process.exitCode = 2;
}
