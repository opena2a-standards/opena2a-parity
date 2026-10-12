import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Node runs the harness and its tests by stripping their type annotations without checking them, so
// a type error fails no other test: two stood in test/cross-cli.test.ts while the suite passed. The
// tests here run the compiler over the harness and the whole suite with the options in
// tsconfig.json, which is the check `npm run typecheck` runs on its own.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// A consumer whose workflow pin carries the unit-test step runs `npm test` from this repository's
// main. Node runs the harness the same with or without a type error, so one has no bearing on a
// consumer's CLI parity, and the check runs locally and in this repository's own CI only.
export function skipReason(repository: string | undefined): string | false {
  if (!repository || repository.endsWith("/opena2a-parity")) return false;
  return `type-checks opena2a-parity's own sources; not run on behalf of ${repository}`;
}

const skip = skipReason(process.env.GITHUB_REPOSITORY);

// The arguments the `typecheck` script gives the compiler, so the script and these tests run one check.
function scriptArgs(): string[] {
  const { scripts } = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  const [command, ...args] = (scripts?.typecheck ?? "").split(/\s+/);
  assert.equal(command, "tsc", "package.json must keep a `typecheck` script that runs tsc");
  return args;
}

// The command-line entry of the compiler package.json pins, as that package's own manifest names it.
function compilerEntry(): string {
  let manifestPath: string;
  try {
    manifestPath = createRequire(import.meta.url).resolve("typescript/package.json");
  } catch {
    throw new Error("the type check needs the compiler package.json pins as a dev dependency: run `npm install`");
  }
  const { bin } = JSON.parse(readFileSync(manifestPath, "utf8")) as { bin: { tsc: string } };
  return resolve(dirname(manifestPath), bin.tsc);
}

function compile(extraArgs: string[] = []): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [compilerEntry(), ...scriptArgs(), ...extraArgs], { cwd: repoRoot, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("the harness and its tests pass the strict type check", { skip }, () => {
  const r = compile();
  assert.equal(r.status, 0, `the compiler reports:\n${r.stdout}${r.stderr}`);
});

test("the type check reads the harness and every test file", { skip }, () => {
  // A check that passes because tsconfig.json no longer names a file would say nothing about it.
  const r = compile(["--listFilesOnly"]);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const read = new Set(r.stdout.split("\n").filter((line) => line !== "").map((line) => realpathSync(line)));
  const sources = ["src", "test"].flatMap((dir) =>
    readdirSync(join(repoRoot, dir), { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".ts"))
      .map((name) => join(dir, name)),
  );
  const unread = sources.filter((path) => !read.has(realpathSync(join(repoRoot, path))));
  assert.deepEqual(unread, [], `tsconfig.json leaves these out of the type check: ${unread.join(", ")}`);
  assert.ok(sources.includes(join("src", "run-parity.ts")) && sources.length > 1, sources.join(", "));
});

test("the type check runs locally and in this repository, and skips for a consumer", () => {
  assert.equal(skipReason(undefined), false);
  assert.equal(skipReason(""), false);
  assert.equal(skipReason("opena2a-org/opena2a-parity"), false);
  assert.equal(skipReason("opena2a-standards/opena2a-parity"), false);
  assert.match(String(skipReason("opena2a-org/hackmyagent")), /not run on behalf of opena2a-org\/hackmyagent/);
});
