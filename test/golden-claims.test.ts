import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

// A comment that says a CLI's golden of a fixture omits a must-match key is read as the state of that
// committed golden. Re-baselining the golden to carry the key does not touch the comment: after the
// ai-trust goldens of check-registered-ai and check-registered-ai-pypi took scanStatus, comments in
// src/ and test/ went on describing the omission as current. Here each such sentence is checked
// against the golden it names.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export type CommittedFixture = { name: string; mustMatch: string[]; goldens: Record<string, Record<string, unknown>> };

// Each fixture with a contract, its must-match keys, and the participant goldens that parse as a JSON object.
function committedFixtures(): CommittedFixture[] {
  const root = join(repoRoot, "fixtures");
  return readdirSync(root)
    .filter((name) => existsSync(join(root, name, "contract.yaml")))
    .map((name) => {
      const contract = parseYaml(readFileSync(join(root, name, "contract.yaml"), "utf8")) as { participants?: string[]; must_match?: string[] };
      const goldens: Record<string, Record<string, unknown>> = {};
      for (const cli of contract.participants ?? []) {
        const path = join(root, name, "expected", `${cli}.json`);
        if (!existsSync(path)) continue;
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) goldens[cli] = parsed as Record<string, unknown>;
      }
      return { name, mustMatch: contract.must_match ?? [], goldens };
    });
}

// The sentences of the `//` comments in a source, each with the line it starts on. Consecutive comment
// lines form one comment; a sentence ends at a full stop followed by white space or the comment's end.
export function commentSentences(source: string): { line: number; text: string }[] {
  const sentences: { line: number; text: string }[] = [];
  let words: { line: number; word: string }[] = [];
  const flush = () => {
    let start = 0;
    for (let i = 0; i < words.length; i++) {
      if (words[i].word.endsWith(".") || i === words.length - 1) {
        sentences.push({ line: words[start].line, text: words.slice(start, i + 1).map((w) => w.word).join(" ") });
        start = i + 1;
      }
    }
    words = [];
  };
  source.split("\n").forEach((raw, index) => {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("//")) return flush();
    for (const word of trimmed.replace(/^\/\/+/, "").split(/\s+/).filter(Boolean)) words.push({ line: index + 1, word });
  });
  flush();
  return sentences;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
const OMISSION = /\bomi(?:ts?|tted|ssion)\b/;
// A sentence about how a golden used to be is history, not a claim about the committed golden.
const PAST = /\b(?:before|until|was|were|did)\b/;

// The sentences that say a CLI's golden omits a must-match key its committed golden carries. A sentence
// claims this when it holds an omission word, the key, and the CLI as a possessive (ai-trust's) or as
// the subject of "omits". It is about the fixtures it names; one that names none and speaks of the
// "committed golden" is about every fixture, and holds while any golden of that CLI omits the key.
export function staleOmissionClaims(source: string, fixtures: CommittedFixture[]): string[] {
  const stale: string[] = [];
  for (const { line, text } of commentSentences(source)) {
    if (!OMISSION.test(text) || PAST.test(text)) continue;
    const named = fixtures.filter((f) => new RegExp(`(?<![\\w-])${escape(f.name)}(?![\\w-])`).test(text));
    const about = named.length > 0 ? named : /\bcommitted golden\b/.test(text) ? fixtures : [];
    const clis = new Set(about.flatMap((f) => Object.keys(f.goldens)));
    for (const cli of clis) {
      if (!new RegExp(`(?<![\\w-])${escape(cli)}(?:'s\\b|\\s+omits\\b)`).test(text)) continue;
      const keys = new Set(about.flatMap((f) => f.mustMatch.filter((k) => /^\w+$/.test(k) && new RegExp(`\\b${k}\\b`).test(text))));
      for (const key of keys) {
        const holding = about.filter((f) => f.mustMatch.includes(key) && f.goldens[cli] !== undefined);
        const carriers = holding.filter((f) => key in f.goldens[cli]);
        if (carriers.length > 0 && carriers.length === holding.length) {
          stale.push(`line ${line}: ${cli}'s golden of ${carriers.map((f) => f.name).join(", ")} carries ${key}, but the comment says it omits it: ${text}`);
        }
      }
    }
  }
  return stale;
}

function sourceFiles(): string[] {
  return ["src", "test"].flatMap((dir) =>
    readdirSync(join(repoRoot, dir))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => join(repoRoot, dir, name)),
  );
}

test("no comment in src/ or test/ says a CLI's golden omits a must-match key its committed golden carries", () => {
  const fixtures = committedFixtures();
  assert.ok(fixtures.some((f) => Object.keys(f.goldens).length > 1), "expected fixtures/*/expected/*.json goldens");
  const files = sourceFiles();
  assert.ok(files.some((file) => file.endsWith("run-parity.ts")), "expected src/run-parity.ts");
  const problems = files.flatMap((file) =>
    staleOmissionClaims(readFileSync(file, "utf8"), fixtures).map((p) => `${relative(repoRoot, file)} ${p}`),
  );
  assert.deepEqual(problems, [], "Describe the golden as it is committed, or the stub the test builds, instead.");
});

test("an omission claim is checked against the golden of the fixture it names, or of every fixture for the committed golden", () => {
  const fixtures: CommittedFixture[] = [
    { name: "check-pkg", mustMatch: ["verdict", "scanStatus"], goldens: { hma: { verdict: "passed", scanStatus: "warnings" }, "ai-trust": { verdict: "passed", scanStatus: "warnings" } } },
    { name: "check-pkg-pypi", mustMatch: ["verdict", "scanStatus"], goldens: { hma: { verdict: "listed", scanStatus: "pending" }, "ai-trust": { verdict: "listed" } } },
  ];
  // a named fixture whose golden carries the key is reported, once per sentence, with its line
  const stale = staleOmissionClaims("const a = 1;\n// check-pkg: scanStatus is a must-match key that ai-trust's golden\n// omits on purpose. Nothing else.\n", fixtures);
  assert.equal(stale.length, 1, stale.join("\n"));
  assert.match(stale[0], /^line 2: ai-trust's golden of check-pkg carries scanStatus, /);
  // the possessive may follow the key, and "omits" may take the CLI as its subject
  assert.equal(staleOmissionClaims("// check-pkg's scanStatus is in the hma golden and omitted from ai-trust's.", fixtures).length, 1);
  assert.equal(staleOmissionClaims("// ai-trust omits scanStatus on check-pkg.", fixtures).length, 1);
  // check-pkg-pypi is another fixture, not check-pkg, and its ai-trust golden does omit the key
  assert.deepEqual(staleOmissionClaims("// ai-trust's golden omits scanStatus on check-pkg-pypi.", fixtures), []);
  // the committed golden with no fixture named holds while one golden of that CLI omits the key
  assert.deepEqual(staleOmissionClaims("// ai-trust omits scanStatus, as its committed golden does.", fixtures), []);
  const carriedEverywhere = [fixtures[0], { ...fixtures[1], goldens: { ...fixtures[1].goldens, "ai-trust": { verdict: "listed", scanStatus: "pending" } } }];
  assert.equal(staleOmissionClaims("// ai-trust omits scanStatus, as its committed golden does.", carriedEverywhere).length, 1);
  // a stub described without a fixture, a sentence with no omission, and history are not claims about a committed golden
  assert.deepEqual(staleOmissionClaims("// the stub's ai-trust golden omits scanStatus.", fixtures), []);
  assert.deepEqual(staleOmissionClaims("// ai-trust's golden of check-pkg carries scanStatus.", fixtures), []);
  assert.deepEqual(staleOmissionClaims("// ai-trust's golden of check-pkg omitted scanStatus before #107.", fixtures), []);
  // a key outside must_match and a CLI that is not a participant say nothing about the contract
  assert.deepEqual(staleOmissionClaims("// hma's golden omits trustScore on check-pkg.", fixtures), []);
  assert.deepEqual(staleOmissionClaims("// opena2a's golden omits scanStatus on check-pkg.", fixtures), []);
  // a code line ends the comment, so a sentence does not run on into the next comment
  assert.deepEqual(commentSentences("// first\nconst x = 1;\n// second."), [{ line: 1, text: "first" }, { line: 3, text: "second." }]);
});
