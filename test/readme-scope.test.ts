import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

// The harness compares each fixture's must_match keys and nothing else across the CLIs, so the README
// may not describe the gate as proving whole-output identity while the committed goldens differ
// outside those keys.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const WHOLE_OUTPUT_CLAIM = /\b(?:identical|same|equal) outputs?\b/i;

// Fixtures whose participating goldens are not equal as whole documents.
function fixturesWithDifferingGoldens(): string[] {
  const differing: string[] = [];
  for (const fixture of readdirSync(join(repoRoot, "fixtures"))) {
    const expected = join(repoRoot, "fixtures", fixture, "expected");
    if (!existsSync(expected)) continue;
    const goldens = readdirSync(expected)
      .filter((n) => n.endsWith(".json"))
      .map((n) => JSON.parse(readFileSync(join(expected, n), "utf8")));
    if (goldens.some((g) => !isDeepStrictEqual(g, goldens[0]))) differing.push(fixture);
  }
  return differing;
}

test("README.md does not claim identical whole outputs while the goldens differ outside must_match", () => {
  const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
  const differing = fixturesWithDifferingGoldens();
  if (differing.length === 0) return;
  const claim = readme.match(WHOLE_OUTPUT_CLAIM)?.[0] ?? null;
  assert.equal(
    claim,
    null,
    `README.md says "${claim}", but the goldens of ${differing.join(", ")} differ outside their must_match keys. ` +
      "Describe the gate as comparing each fixture's contract-tracked fields.",
  );
  assert.match(readme, /identical values on each fixture's contract-tracked fields/);
});

test("the whole-output claim pattern matches the old wording and not the contract-tracked wording", () => {
  assert.match("the CI gate that proves identical output on identical input", WHOLE_OUTPUT_CLAIM);
  assert.match("all three CLIs print the same output", WHOLE_OUTPUT_CLAIM);
  assert.doesNotMatch("identical values on each fixture's contract-tracked fields", WHOLE_OUTPUT_CLAIM);
  assert.doesNotMatch("given the same input", WHOLE_OUTPUT_CLAIM);
});
