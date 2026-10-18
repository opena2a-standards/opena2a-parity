import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureNames } from "../src/run-parity.ts";

// `npm run parity` runs every directory under fixtures/ and fails one with no contract.yaml, so a deleted
// or renamed contract shows in its output. These tests refuse that state in the committed tree, before any
// run: every entry of fixtures/ is a fixture directory with a contract.yaml, and the Fixtures: line of
// docs/status.md names exactly those directories.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const fixturesDir = join(repoRoot, "fixtures");

// A name that starts with "." (.DS_Store on macOS) belongs to the operating system or a contributor's
// tools, not to the repository.
const isDotName = (name: string) => name.startsWith(".");

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

test("every entry of fixtures/ is a directory that holds a contract.yaml", () => {
  const entries = readdirSync(fixturesDir).filter((name) => !isDotName(name));
  assert.ok(entries.length > 0, "expected at least one fixtures/<name>/");
  const directories = new Set(fixtureNames(fixturesDir));
  const problems = entries.flatMap((name) => {
    if (!directories.has(name)) return [`fixtures/${name} is not a directory, so \`npm run parity\` does not run it; move it into a fixture directory or remove it`];
    if (!isFile(join(fixturesDir, name, "contract.yaml"))) {
      return [`fixtures/${name} holds no contract.yaml file, so \`npm run parity\` fails it; write fixtures/${name}/contract.yaml (docs/adding-a-fixture.md) or remove the directory`];
    }
    return [];
  });
  assert.deepEqual(problems, []);
});

test("the Fixtures: line of docs/status.md names exactly the directories under fixtures/", () => {
  const lines = readFileSync(join(repoRoot, "docs", "status.md"), "utf8").split("\n").filter((line) => line.includes("Fixtures:"));
  assert.equal(lines.length, 1, `expected one line holding "Fixtures:" in docs/status.md, found ${lines.length}`);
  const listed = [...new Set([...lines[0].slice(lines[0].indexOf("Fixtures:")).matchAll(/`([^`]+)`/g)].map((m) => m[1]))].sort();
  // A line whose shape changed parses to no name; that fails here instead of being compared.
  assert.ok(listed.length > 0, `no fixture name in backticks after "Fixtures:" in docs/status.md: ${lines[0]}`);
  const directories = fixtureNames(fixturesDir).filter((name) => !isDotName(name)).sort();
  assert.deepEqual(listed, directories, "Name each directory under fixtures/ in backticks on the Fixtures: line of docs/status.md, and no other name.");
});
