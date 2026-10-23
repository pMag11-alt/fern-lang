import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, test } from "node:test";

import { run } from "../src/index.js";

const dir = new URL("../../examples/", import.meta.url);

/** What a program prints, followed by its formatted errors, exactly as the CLI shows them. */
function transcript(file: string): string {
  const result = run(readFileSync(new URL(file, dir), "utf8"), { fileName: file });
  return [...result.output, ...result.errors].join("\n") + "\n";
}

// Golden tests: each example's output must match its .out file. Run with UPDATE_GOLDEN=1 to rewrite them.
describe("examples", () => {
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".fern")).sort()) {
    test(file, () => {
      const expectedFile = new URL(file.replace(/\.fern$/, ".out"), dir);
      if (process.env.UPDATE_GOLDEN) writeFileSync(expectedFile, transcript(file));
      assert.equal(transcript(file), readFileSync(expectedFile, "utf8"));
    });
  }
});
