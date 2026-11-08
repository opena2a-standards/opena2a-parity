import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { fixtureNames } from "../src/run-parity.ts";
// Importing this module also registers its tests in this file's run.
import { checkoutSkipReason, gitEnv } from "./ignore-file.test.ts";

// A directory fixture's golden describes what its CLI reports on the fixture's input/, and its findings
// name input files by their path under input/: the `file` of a finding and each entry of a finding's
// details.files. A golden that names a file the repository does not hold describes an input other than
// the committed one. The secure-dirty-skill goldens named .claude/settings.json, .cursorrules, .env and
// .env.local, none of them committed (#25); that fixture's input/.gitignore lists .env and .env.*, so
// git status does not show those two files there. Here each such path is checked against the input on
// disk and, in a git checkout of this repository, against the files git tracks under input/.
//
// A failed GIT-001 ("Missing .gitignore") names the file it did not find, so its path is checked the
// other way round: the input must not hold it. The secure-empty-dir goldens carry one.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const fixturesDir = join(repoRoot, "fixtures");

const REPORTS_FILE_MISSING = new Set(["GIT-001"]);

const FIX =
  "A golden describes the input committed beside it. Commit each input file it names, with placeholder values " +
  "(git add -f where an ignore file lists it), or take the findings on files that are not committed out of the golden.";

export type NamedPath = { path: string; absent: boolean };

// The paths a golden names: the string `file` of each object in its findings and allFindings arrays, and
// each string in that object's details.files. `absent` marks the file of a failed GIT-001.
export function namedPaths(golden: unknown): NamedPath[] {
  const named: NamedPath[] = [];
  if (golden === null || typeof golden !== "object") return named;
  for (const key of ["findings", "allFindings"]) {
    const entries: unknown = (golden as Record<string, unknown>)[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry === null || typeof entry !== "object") continue;
      const { checkId, passed, file, details } = entry as Record<string, unknown>;
      if (typeof file === "string") {
        named.push({ path: file, absent: passed === false && typeof checkId === "string" && REPORTS_FILE_MISSING.has(checkId) });
      }
      const files: unknown = details !== null && typeof details === "object" ? (details as Record<string, unknown>).files : undefined;
      if (Array.isArray(files)) for (const f of files) if (typeof f === "string") named.push({ path: f, absent: false });
    }
  }
  return named;
}

// One line per distinct path a golden names that `holds` does not answer as the golden says.
export function pathProblems(golden: string, where: string, named: NamedPath[], holds: (path: string) => boolean): string[] {
  const problems = new Set<string>();
  for (const { path, absent } of named) {
    if (absent && holds(path)) problems.add(`${golden} reports ${path} missing, but it is in ${where}`);
    else if (!absent && !holds(path)) problems.add(`${golden} names ${path}, which is not in ${where}`);
  }
  return [...problems];
}

type DirectoryFixture = { name: string; goldens: { golden: string; named: NamedPath[] }[] };

// Each directory fixture with the paths named by each participant's golden. The harness reads a contract
// with no kind as a directory fixture, so every fixture whose kind is not package-name is one here.
function directoryFixtures(): DirectoryFixture[] {
  return fixtureNames(fixturesDir).flatMap((name) => {
    const contract = (parseYaml(readFileSync(join(fixturesDir, name, "contract.yaml"), "utf8")) ?? {}) as { kind?: unknown; participants?: unknown };
    if (contract.kind === "package-name") return [];
    const participants: unknown[] = Array.isArray(contract.participants) ? contract.participants : [];
    const goldens = participants.flatMap((cli) => {
      if (typeof cli !== "string") return [];
      const path = join(fixturesDir, name, "expected", `${cli}.json`);
      if (!existsSync(path)) return [];
      return [{ golden: `fixtures/${name}/expected/${cli}.json`, named: namedPaths(JSON.parse(readFileSync(path, "utf8"))) }];
    });
    return [{ name, goldens }];
  });
}

test("every input path a directory fixture's golden names is in that fixture's input/", () => {
  const fixtures = directoryFixtures();
  assert.ok(
    fixtures.some(({ goldens }) => goldens.some(({ named }) => named.length > 0)),
    "expected at least one directory fixture whose golden names an input path",
  );
  const problems = fixtures.flatMap(({ name, goldens }) => {
    const input = join(fixturesDir, name, "input");
    const holds = (path: string) => {
      const rel = relative(input, join(input, path));
      return rel !== "" && rel.split(sep)[0] !== ".." && existsSync(join(input, path));
    };
    return goldens.flatMap(({ golden, named }) => pathProblems(golden, `fixtures/${name}/input/`, named, holds));
  });
  assert.deepEqual(problems, [], FIX);
});

test("every input path a directory fixture's golden names is committed under that fixture's input/", { skip: checkoutSkipReason(repoRoot, process.env) }, () => {
  const problems = directoryFixtures().flatMap(({ name, goldens }) => {
    const dir = `fixtures/${name}/input`;
    const r = spawnSync("git", ["-C", repoRoot, "ls-files", "-z", "--", dir], { encoding: "utf8", env: gitEnv(process.env) });
    assert.equal(r.status, 0, `git ls-files ${dir} failed: ${r.stderr}`);
    const tracked = r.stdout
      .split("\0")
      .filter((p) => p.startsWith(`${dir}/`))
      .map((p) => p.slice(dir.length + 1));
    const holds = (path: string) => path !== "" && tracked.some((t) => t === path || t.startsWith(`${path}/`));
    return goldens.flatMap(({ golden, named }) => pathProblems(golden, `the files git tracks under ${dir}/`, named, holds));
  });
  assert.deepEqual(problems, [], FIX);
});

test("a golden's input paths are the file and details.files of its findings and allFindings, and a failed GIT-001's file must be absent", () => {
  const named = namedPaths({
    score: 0,
    findings: [
      { checkId: "CRED-001", passed: false, file: ".env" },
      { checkId: "GIT-001", passed: false, file: ".gitignore" },
    ],
    allFindings: [
      { checkId: "PERM-001", passed: false, details: { files: ["a.key", 3] } },
      { checkId: "GIT-001", passed: true, file: "sub/.gitignore" },
      null,
      "text",
    ],
    semanticAnalysis: { findings: [{ file: "elsewhere.md" }] },
  });
  assert.deepEqual(named, [
    { path: ".env", absent: false },
    { path: ".gitignore", absent: true },
    { path: "a.key", absent: false },
    { path: "sub/.gitignore", absent: false },
  ]);
  const held = new Set([".gitignore", "a.key", "sub/.gitignore"]);
  assert.deepEqual(pathProblems("g.json", "input/", [...named, { path: ".env", absent: false }], (p) => held.has(p)), [
    "g.json names .env, which is not in input/",
    "g.json reports .gitignore missing, but it is in input/",
  ]);
});
