import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { missingBinMessages } from "../src/run-parity.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

test("missingBinMessages names each CLI variable that is unset or empty, one line each", () => {
  assert.deepEqual(missingBinMessages({ HMA_BIN: "node hma.js", OPENA2A_BIN: "node opena2a.js", AI_TRUST_BIN: "node ai-trust.js" }), []);
  assert.deepEqual(missingBinMessages({ HMA_BIN: "", OPENA2A_BIN: "node opena2a.js" }), [
    'env var HMA_BIN is required — e.g. HMA_BIN="node /path/to/dist/cli.js"',
    'env var AI_TRUST_BIN is required — e.g. AI_TRUST_BIN="node /path/to/dist/cli.js"',
  ]);
});

test("npm run parity without a CLI variable prints one line per variable and exits 2, without a stack trace", () => {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "src/run-parity.ts"], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH, OPENA2A_BIN: "node opena2a.js", AI_TRUST_BIN: "node ai-trust.js" },
    encoding: "utf8",
  });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stderr.trim(), 'env var HMA_BIN is required — e.g. HMA_BIN="node /path/to/dist/cli.js"');
  assert.doesNotMatch(r.stderr, /^\s+at /m);
});

test("npm run parity with commands that cannot start reports each leg once, with Node's own line, and exits 1 without a retry", () => {
  const dir = mkdtempSync(join(tmpdir(), "parity-cli-missing-"));
  const bin = `node ${join(dir, "missing.mjs")}`;
  try {
    // PARITY_PROBE_BACKOFF_MS is not passed on, so the default backoff is in force: a retried leg sleeps 4.5 s.
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "src/run-parity.ts"], {
      cwd: repoRoot,
      env: { PATH: process.env.PATH, HMA_BIN: bin, OPENA2A_BIN: bin, AI_TRUST_BIN: bin },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(r.status, 1, `${r.error ?? ""}\n${r.stderr}`);
    assert.ok(r.stderr.includes("could not start (exit=1): Error: Cannot find module"), r.stderr);
    assert.ok(!r.stderr.includes("transient probe failure"), r.stderr);
    assert.ok(!r.stderr.includes("First 400 chars"), r.stderr);
    const summary = r.stdout.split("\n").filter((line) => line.trim() !== "").at(-1) ?? "";
    assert.match(summary, /^(\d+) fixture\(s\) run, \1 fixture failure\(s\)$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
