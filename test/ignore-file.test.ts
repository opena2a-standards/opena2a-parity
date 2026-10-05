import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The committed ignore file covers only what working in this repository produces: installed
// dependencies, logs, OS metadata and the harness's own run output. Exclusions for a contributor's
// personal editor or tooling state belong in that contributor's .git/info/exclude or global ignore
// file, not here. Adding a rule is a deliberate change to this list.

const EXPECTED_RULES = ["node_modules/", "*.log", ".DS_Store", "/actual/", "/tmp-checkouts/"];

test(".gitignore carries only the repository's own build and run-output rules", () => {
  const lines = readFileSync(new URL("../.gitignore", import.meta.url), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  assert.deepEqual(lines, EXPECTED_RULES);
});
