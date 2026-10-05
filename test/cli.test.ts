import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
