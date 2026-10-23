import { check, printProgram, SourceFile, tokenize, type Diagnostic } from "../src/index.js";
import { escapeHtml, highlight } from "./highlight.js";
import { decodeShare, encodeShare } from "./share.js";
import type { WorkerMessage } from "./worker.js";

const MAX_OUTPUT_LINES = 5000;
const STORAGE_KEY = "fern.code";

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;

const editor = $<HTMLTextAreaElement>("#code");
const highlighted = $<HTMLElement>("#highlight");
const gutter = $<HTMLElement>("#gutter");
const runButton = $<HTMLButtonElement>("#run");
const stopButton = $<HTMLButtonElement>("#stop");
const examplesSelect = $<HTMLSelectElement>("#examples");
const output = $<HTMLElement>("#panel-output");
const tokensView = $<HTMLElement>("#tokens");
const astView = $<HTMLElement>("#ast");
const runStatus = $<HTMLElement>("#run-status");
const problemsButton = $<HTMLButtonElement>("#problems");
const cursorLabel = $<HTMLElement>("#cursor");
const toast = $<HTMLElement>("#toast");

let problems: Diagnostic[] = [];
let runtimeProblem: Diagnostic | null = null;
let worker: Worker | null = null;
let outputLines = 0;
let activeTab = "output";

// ---- editor rendering ------------------------------------------------------------------------------------------

function render(): void {
  const code = editor.value;
  highlighted.innerHTML = highlight(code, runtimeProblem ? [...problems, runtimeProblem] : problems);
  const lines = code.split("\n").length;
  const badLines = new Set(
    [...problems, ...(runtimeProblem ? [runtimeProblem] : [])].map((d) => lineOf(code, d.span.start)),
  );
  let numbers = "";
  for (let i = 1; i <= lines; i++) numbers += badLines.has(i) ? `<span class="bad-line">${i}</span>\n` : `${i}\n`;
  gutter.innerHTML = numbers;
  syncScroll();
}

function syncScroll(): void {
  highlighted.scrollTop = editor.scrollTop;
  highlighted.scrollLeft = editor.scrollLeft;
  gutter.scrollTop = editor.scrollTop;
}

function lineOf(code: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < code.length; i++) if (code.charCodeAt(i) === 10) line++;
  return line;
}

/** Re-checks the program for syntax and name errors as you type, without running it. */
function analyse(): void {
  const source = new SourceFile("main.fern", editor.value);
  try {
    problems = check(source).diagnostics;
  } catch {
    problems = [];
  }
  render();
  updateProblems();
  if (activeTab === "tokens") renderTokens();
  if (activeTab === "ast") renderAst();
}

function updateProblems(): void {
  const all = runtimeProblem ? [...problems, runtimeProblem] : problems;
  problemsButton.classList.toggle("has-problems", all.length > 0);
  if (all.length === 0) {
    problemsButton.textContent = "✓ No problems";
    problemsButton.title = "";
    return;
  }
  const first = all[0]!;
  const { line, col } = new SourceFile("main.fern", editor.value).position(first.span.start);
  const more = all.length > 1 ? ` (+${all.length - 1} more)` : "";
  const hint = first.hint ? ` · ${first.hint}` : "";
  problemsButton.textContent = `✕ ${line}:${col} ${first.message}${hint}${more}`;
  problemsButton.title = "Click to jump to the problem";
}

function updateCursor(): void {
  const before = editor.value.slice(0, editor.selectionStart);
  const line = before.split("\n").length;
  const col = before.length - before.lastIndexOf("\n");
  cursorLabel.textContent = `Ln ${line}, Col ${col}`;
}

let analyseTimer = 0;
let saveTimer = 0;
function onEdit(): void {
  runtimeProblem = null;
  render();
  updateCursor();
  clearTimeout(analyseTimer);
  analyseTimer = window.setTimeout(analyse, 200);
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => store(STORAGE_KEY, editor.value), 500);
}

function select(start: number, end: number): void {
  editor.focus();
  editor.setSelectionRange(start, Math.max(end, start + 1));
  // Scroll the selection into view: blur/focus is the portable way to make a textarea scroll to its caret.
  const line = lineOf(editor.value, start);
  const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 22;
  editor.scrollTop = Math.max(0, (line - 4) * lineHeight);
  updateCursor();
}

// ---- keyboard --------------------------------------------------------------------------------------------------

/** Inserts text through the browser's editing command when possible, so Ctrl+Z still works. */
function insert(text: string): void {
  if (!document.execCommand("insertText", false, text)) {
    editor.setRangeText(text, editor.selectionStart, editor.selectionEnd, "end");
    editor.dispatchEvent(new Event("input"));
  }
}

editor.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    runProgram();
    return;
  }
  if (event.key === "Escape" && worker) {
    stopProgram();
    return;
  }
  const { value, selectionStart: start, selectionEnd: end } = editor;
  if (event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    if (start === end && !event.shiftKey) {
      insert("  ");
      return;
    }
    // Indent or outdent every selected line.
    const block = value.slice(lineStart, end);
    const changed = event.shiftKey ? block.replace(/^ {1,2}/gm, "") : block.replace(/^/gm, "  ");
    editor.setSelectionRange(lineStart, end);
    insert(changed);
    editor.setSelectionRange(lineStart, lineStart + changed.length);
    return;
  }
  if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
    // Keep the current indentation, add a level after an opening bracket, and put a closing one on its own line.
    event.preventDefault();
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const indent = /^[ \t]*/.exec(value.slice(lineStart, start))![0];
    const before = value[start - 1] ?? "";
    const after = value[start] ?? "";
    if ("{[(".includes(before) && before !== "") {
      const closes = (before === "{" && after === "}") || (before === "[" && after === "]") || (before === "(" && after === ")");
      insert(`\n${indent}  ` + (closes ? `\n${indent}` : ""));
      if (closes) editor.setSelectionRange(start + indent.length + 3, start + indent.length + 3);
    } else {
      insert(`\n${indent}`);
    }
    return;
  }
  if (event.key === "}" && start === end) {
    // Typing '}' on a blank line removes one level of indentation first.
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const typed = value.slice(lineStart, start);
    if (/^ {2,}$/.test(typed)) {
      event.preventDefault();
      editor.setSelectionRange(start - 2, start);
      insert("}");
    }
  }
});

editor.addEventListener("input", onEdit);
editor.addEventListener("scroll", syncScroll);
editor.addEventListener("keyup", updateCursor);
editor.addEventListener("click", updateCursor);

problemsButton.addEventListener("click", () => {
  const first = (runtimeProblem ? [...problems, runtimeProblem] : problems)[0];
  if (first) select(first.span.start, first.span.end);
});

// ---- running ---------------------------------------------------------------------------------------------------

function runProgram(): void {
  if (worker) return;
  switchTab("output");
  output.textContent = "";
  outputLines = 0;
  runtimeProblem = null;
  setRunning(true);
  runStatus.textContent = "Running…";
  runStatus.className = "run-status";

  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
    const message = event.data;
    if (message.type === "print") {
      appendLines(message.lines);
      return;
    }
    finish();
    for (const [i, error] of message.errors.entries()) appendError(error, message.diagnostics[i]);
    if (message.ok) {
      if (outputLines === 0) appendNote("(no output)");
      runStatus.textContent = `Finished in ${formatTime(message.milliseconds)}`;
      runStatus.className = "run-status ok";
    } else {
      const runtime = message.diagnostics.find((d) => d.phase === "runtime");
      runtimeProblem = runtime ?? null;
      runStatus.textContent = runtime ? "Stopped by a runtime error" : `${plural(message.errors.length, "problem")} found`;
      runStatus.className = "run-status failed";
      render();
      updateProblems();
    }
  };
  worker.onerror = (event) => {
    finish();
    appendError(`internal error: ${event.message}`);
  };
  worker.postMessage({ code: editor.value });
}

function stopProgram(): void {
  if (!worker) return;
  finish();
  appendNote("■ Stopped");
  runStatus.textContent = "Stopped";
  runStatus.className = "run-status failed";
}

function finish(): void {
  worker?.terminate();
  worker = null;
  setRunning(false);
}

function setRunning(running: boolean): void {
  runButton.hidden = running;
  stopButton.hidden = !running;
  output.classList.toggle("running", running);
}

function appendLines(lines: string[]): void {
  if (outputLines >= MAX_OUTPUT_LINES) return;
  const room = MAX_OUTPUT_LINES - outputLines;
  const shown = lines.slice(0, room);
  output.append(shown.join("\n") + "\n");
  outputLines += shown.length;
  if (lines.length > room) appendNote(`… output truncated after ${MAX_OUTPUT_LINES} lines`);
  output.scrollTop = output.scrollHeight;
}

function appendError(text: string, diagnostic?: Diagnostic): void {
  const block = document.createElement("button");
  block.type = "button";
  block.className = "error-block";
  block.innerHTML = escapeHtml(text).replace(/^(.*?:)/, '<strong>$1</strong>');
  if (diagnostic) {
    block.title = "Click to show in the editor";
    block.addEventListener("click", () => select(diagnostic.span.start, diagnostic.span.end));
  }
  output.append(block);
  output.scrollTop = output.scrollHeight;
}

function appendNote(text: string): void {
  const note = document.createElement("span");
  note.className = "note";
  note.textContent = text + "\n";
  output.append(note);
}

function formatTime(ms: number): string {
  return ms < 1 ? "< 1 ms" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

runButton.addEventListener("click", runProgram);
stopButton.addEventListener("click", stopProgram);

// ---- tokens and AST tabs ---------------------------------------------------------------------------------------

function renderTokens(): void {
  const source = new SourceFile("main.fern", editor.value);
  const rows = tokenize(source).tokens.map((token) => {
    const { line, col } = source.position(token.span.start);
    const text = token.virtual ? '<span class="muted">newline → ;</span>' : escapeHtml(token.text) || '<span class="muted">end</span>';
    return `<tr data-start="${token.span.start}" data-end="${token.span.end}"><td>${line}:${col}</td><td>${token.kind}</td><td>${text}</td></tr>`;
  });
  tokensView.innerHTML = `<table><thead><tr><th>Line:Col</th><th>Kind</th><th>Text</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

tokensView.addEventListener("click", (event) => {
  const row = (event.target as HTMLElement).closest<HTMLElement>("tr[data-start]");
  if (row) select(Number(row.dataset.start), Number(row.dataset.end));
});

function renderAst(): void {
  const { program, diagnostics } = check(new SourceFile("main.fern", editor.value));
  const note = diagnostics.some((d) => d.phase === "syntax") ? "; partial tree: the program has syntax errors\n" : "";
  astView.textContent = note + printProgram(program);
}

function switchTab(name: string): void {
  activeTab = name;
  for (const tab of document.querySelectorAll<HTMLButtonElement>("[role=tab]")) {
    const selected = tab.dataset.tab === name;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const panel of document.querySelectorAll<HTMLElement>("[role=tabpanel]")) {
    panel.hidden = panel.id !== `panel-${name}`;
  }
  if (name === "tokens") renderTokens();
  if (name === "ast") renderAst();
}

for (const tab of document.querySelectorAll<HTMLButtonElement>("[role=tab]")) {
  tab.addEventListener("click", () => switchTab(tab.dataset.tab!));
}

// ---- examples, sharing, theme, help ----------------------------------------------------------------------------

interface Example {
  file: string;
  title: string;
}

async function loadExamples(): Promise<Example[]> {
  try {
    const response = await fetch("examples/index.json");
    const examples = (await response.json()) as Example[];
    for (const example of examples) examplesSelect.add(new Option(example.title, example.file));
    return examples;
  } catch {
    return [];
  }
}

async function openExample(file: string): Promise<void> {
  const response = await fetch(`examples/${file}`);
  setCode(await response.text());
  if (location.hash) history.replaceState(null, "", location.pathname);
}

examplesSelect.addEventListener("change", () => {
  if (examplesSelect.value) void openExample(examplesSelect.value);
});

function setCode(code: string): void {
  editor.value = code;
  editor.setSelectionRange(0, 0);
  editor.scrollTop = 0;
  output.textContent = "";
  runStatus.textContent = "";
  onEdit();
  analyse();
}

$<HTMLButtonElement>("#share").addEventListener("click", async () => {
  const url = `${location.origin}${location.pathname}#code=${encodeShare(editor.value)}`;
  history.replaceState(null, "", url);
  try {
    await navigator.clipboard.writeText(url);
    showToast("Link copied to the clipboard");
  } catch {
    showToast("Link is in the address bar");
  }
});

function showToast(text: string): void {
  toast.textContent = text;
  toast.hidden = false;
  window.setTimeout(() => (toast.hidden = true), 2200);
}

const themeButton = $<HTMLButtonElement>("#theme");
function applyTheme(theme: string | null): void {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
themeButton.addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches;
  const next = dark ? "light" : "dark";
  applyTheme(next);
  store("fern.theme", next);
});
applyTheme(load("fern.theme"));

const help = $<HTMLDialogElement>("#help");
$<HTMLButtonElement>("#help-open").addEventListener("click", () => help.showModal());
$<HTMLButtonElement>("#help-close").addEventListener("click", () => help.close());

/** Browser storage can be unavailable (private windows, blocked cookies); the page works without it. */
function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not available
  }
}

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// ---- start -----------------------------------------------------------------------------------------------------

/**
 * Chooses what to show first: a shared program (#code=...), an example named in the URL (?example=08-mandelbrot.fern),
 * the program from your last visit, or the first example. With ?run in the URL, it also runs straight away.
 */
async function start(): Promise<void> {
  const examples = await loadExamples();
  const params = new URLSearchParams(location.search);
  const linked = examples.find((e) => e.file === params.get("example"));
  const shared = decodeShare(location.hash);
  const saved = load(STORAGE_KEY);
  if (shared !== null) {
    examplesSelect.value = "";
    setCode(shared);
  } else if (linked) {
    examplesSelect.value = linked.file;
    await openExample(linked.file);
  } else if (saved) {
    examplesSelect.value = "";
    setCode(saved);
  } else if (examples[0]) {
    examplesSelect.value = examples[0].file;
    await openExample(examples[0].file);
  }
  editor.focus();
  if (params.has("run")) runProgram();
}

void start();
