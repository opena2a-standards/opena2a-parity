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

// The words the shell npm runs a script with splits `script` into, with quotes and backslashes
// removed as that shell removes them, so `tsc --project "my config.json"` gives the compiler one
// path. A script that needs more of the shell than its words (an operator, a newline, an
// expansion, a glob or a comment) throws, since the compiler run here would not be the one the
// script runs.
export function shellWords(script: string): string[] {
  const refuse = (what: string): never => {
    throw new Error(`the typecheck script ${JSON.stringify(script)} has ${what}, which these tests do not read as the shell does: give tsc its arguments as plain or quoted words`);
  };
  const words: string[] = [];
  let word: string | undefined;
  for (let i = 0; i < script.length; i++) {
    const c = script[i];
    if (c === " " || c === "\t") {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else if (c === "'") {
      const end = script.indexOf("'", i + 1);
      if (end === -1) refuse("an unterminated '");
      word = (word ?? "") + script.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      word ??= "";
      for (i++; script[i] !== '"'; i++) {
        if (i >= script.length) refuse('an unterminated "');
        let d = script[i];
        if (d === "$" || d === "`") refuse(`${d} inside double quotes`);
        if (d === "\\" && '$`"\\\n'.includes(script[i + 1])) {
          d = script[++i];
          if (d === "\n") continue;
        }
        word += d;
      }
    } else if (c === "\\") {
      if (i + 1 >= script.length) refuse("a trailing \\");
      i++;
      if (script[i] !== "\n") word = (word ?? "") + script[i];
    } else if ("|&;<>()$`*?[{}\n".includes(c) || (word === undefined && (c === "#" || c === "~"))) {
      refuse(c === "\n" ? "a newline" : `an unquoted ${c}`);
    } else {
      word = (word ?? "") + c;
    }
  }
  if (word !== undefined) words.push(word);
  return words;
}

// The `typecheck` script package.json carries, or an empty one when it carries none.
function typecheckScript(): string {
  const { scripts } = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  return scripts?.typecheck ?? "";
}

// The arguments the `typecheck` script gives the compiler, so the script and these tests run one
// check. A test passes `script` in to read a script package.json does not carry.
export function scriptArgs(script: string = typecheckScript()): string[] {
  const [command, ...args] = shellWords(script);
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

test("the typecheck script reaches the compiler as the words the shell splits it into", () => {
  assert.deepEqual(shellWords('tsc --project "my config.json"'), ["tsc", "--project", "my config.json"]);
  assert.deepEqual(shellWords("tsc --project 'my config.json'"), ["tsc", "--project", "my config.json"]);
  assert.deepEqual(shellWords("tsc --project my\\ config.json"), ["tsc", "--project", "my config.json"]);
  assert.deepEqual(shellWords(`tsc -p "my "'con'fig.json`), ["tsc", "-p", "my config.json"]);
  assert.deepEqual(shellWords(`tsc -p "a\\"b\\\\c\\d"`), ["tsc", "-p", 'a"b\\c\\d']);
  assert.deepEqual(shellWords("tsc -p 'it'\\''s.json'"), ["tsc", "-p", "it's.json"]);
  assert.deepEqual(shellWords("tsc \\\n  -p x.json"), ["tsc", "-p", "x.json"]);
  assert.deepEqual(shellWords("  tsc \t --project  tsconfig.json  "), ["tsc", "--project", "tsconfig.json"]);
  assert.deepEqual(shellWords('tsc "" a#b'), ["tsc", "", "a#b"]);
  assert.deepEqual(shellWords('tsc -p "a\\\\\nb"'), ["tsc", "-p", "a\\\nb"]);
  assert.deepEqual(shellWords('tsc -p "a\\\nb"'), ["tsc", "-p", "ab"]);
  assert.deepEqual(shellWords(""), []);
  for (const script of [
    "tsc -p x.json && echo done",
    "tsc -p x.json; echo done",
    "tsc -p x.json\necho done",
    "tsc -p $CONFIG",
    'tsc -p "$CONFIG"',
    "tsc -p `cat name`",
    "tsc -p *.json",
    "tsc -p x.json # a comment",
    "tsc -p ~/x.json",
    "tsc -p 'x.json",
    'tsc -p "x.json',
    "tsc -p x.json\\",
  ]) {
    assert.throws(() => shellWords(script), /give tsc its arguments as plain or quoted words/, script);
  }
});

test("a quoted argument of the typecheck script reaches the compiler without its quotes", () => {
  // The committed script carries no quoted argument, so splitting it on spaces gives the same
  // words and only a script passed in here tells the two apart.
  assert.deepEqual(scriptArgs('tsc --project "tsconfig.json"'), ["--project", "tsconfig.json"]);
  assert.deepEqual(scriptArgs("tsc --project 'my config.json' --pretty false"), ["--project", "my config.json", "--pretty", "false"]);
  assert.deepEqual(scriptArgs("tsc --project my\\ config.json"), ["--project", "my config.json"]);
  assert.deepEqual(scriptArgs('"tsc" --project tsconfig.json'), ["--project", "tsconfig.json"]);
  assert.throws(() => scriptArgs(""), /must keep a `typecheck` script that runs tsc/);
});

test("the type check runs locally and in this repository, and skips for a consumer", () => {
  assert.equal(skipReason(undefined), false);
  assert.equal(skipReason(""), false);
  assert.equal(skipReason("opena2a-org/opena2a-parity"), false);
  assert.equal(skipReason("opena2a-standards/opena2a-parity"), false);
  assert.match(String(skipReason("opena2a-org/hackmyagent")), /not run on behalf of opena2a-org\/hackmyagent/);
});
