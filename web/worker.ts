// Runs programs off the main thread, so an infinite loop can't freeze the page: the Stop button simply terminates
// this worker. Printed lines are sent in batches, roughly every 50 ms, to keep the page responsive.
import { run, type Diagnostic } from "../src/index.js";

export type WorkerMessage =
  | { type: "print"; lines: string[] }
  | { type: "done"; ok: boolean; errors: string[]; diagnostics: Diagnostic[]; milliseconds: number };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ code: string }>) => void) | null;
  postMessage(message: WorkerMessage): void;
};

scope.onmessage = (event) => {
  let pending: string[] = [];
  let lastFlush = performance.now();
  const flush = () => {
    if (pending.length > 0) scope.postMessage({ type: "print", lines: pending });
    pending = [];
    lastFlush = performance.now();
  };
  const result = run(event.data.code, {
    print: (line) => {
      pending.push(line);
      if (pending.length >= 1000 || performance.now() - lastFlush > 50) flush();
    },
    // Without this, a line printed just before a long loop would wait until the loop ends.
    heartbeat: () => {
      if (pending.length > 0 && performance.now() - lastFlush > 50) flush();
    },
  });
  flush();
  scope.postMessage({
    type: "done",
    ok: result.ok,
    errors: result.errors,
    diagnostics: result.diagnostics,
    milliseconds: result.milliseconds,
  });
};
