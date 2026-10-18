import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { fixtureNames } from "../src/run-parity.ts";

// A comment that says a CLI's golden of a fixture omits a must-match key is read as the state of that
// committed golden. Re-baselining the golden to carry the key does not touch the comment: after the
// ai-trust goldens of check-registered-ai and check-registered-ai-pypi took scanStatus, comments in
// src/ and test/ went on describing the omission as current. Here each such sentence is checked
// against the golden it names.
//
// A contract sentence that says a CLI adds checks of its own is read the same way, as a claim about
// the output: a checkId that CLI's capture carries and the other participant's lacks. The
// secure-dirty-skill contract said opena2a adds hygiene checks of its own while a harness run's
// captures carried no such checkId (#120). Here such a sentence must name the check, and the goldens
// must carry it for that CLI alone.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export type CommittedFixture = { name: string; mustMatch: string[]; goldens: Record<string, Record<string, unknown>> };

// Each fixture the harness runs, its must-match keys, and the participant goldens that parse as a JSON
// object. A fixture directory with no contract.yaml fails here, as it fails the harness, instead of being
// passed over.
function committedFixtures(): CommittedFixture[] {
  const root = join(repoRoot, "fixtures");
  return fixtureNames(root)
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

// The sentences a run of words forms, each with the line of its first word: a sentence ends at a word
// that ends with a full stop, or at the last word.
function sentencesOf(words: { line: number; word: string }[]): { line: number; text: string }[] {
  const sentences: { line: number; text: string }[] = [];
  let start = 0;
  for (let i = 0; i < words.length; i++) {
    if (words[i].word.endsWith(".") || i === words.length - 1) {
      sentences.push({ line: words[start].line, text: words.slice(start, i + 1).map((w) => w.word).join(" ") });
      start = i + 1;
    }
  }
  return sentences;
}

// The sentences of the comments in a source, each with the line it starts on: the `//` comments of a
// TypeScript file, or with the `#` marker the comment lines of a YAML file, where the marker is followed
// by white space or ends the line so that `#458` inside a block scalar is not one. Consecutive comment
// lines form one comment; a sentence ends at a full stop followed by white space or the comment's end.
export function commentSentences(source: string, marker: "//" | "#" = "//"): { line: number; text: string }[] {
  const sentences: { line: number; text: string }[] = [];
  let words: { line: number; word: string }[] = [];
  const flush = () => {
    sentences.push(...sentencesOf(words));
    words = [];
  };
  const opens = marker === "#" ? /^#(?:\s|$)/ : /^\/\//;
  const lead = marker === "#" ? /^#/ : /^\/\/+/;
  source.split("\n").forEach((raw, index) => {
    const trimmed = raw.trim();
    if (!opens.test(trimmed)) return flush();
    for (const word of trimmed.replace(lead, "").split(/\s+/).filter(Boolean)) words.push({ line: index + 1, word });
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

// The check ids a golden names: the string `checkId` of each object in each top-level array it holds
// (findings, allFindings).
export function goldenCheckIds(golden: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  for (const value of Object.values(golden)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value as unknown[]) {
      if (entry === null || typeof entry !== "object") continue;
      const { checkId } = entry as { checkId?: unknown };
      if (typeof checkId === "string") ids.add(checkId);
    }
  }
  return ids;
}

// A sentence claims that a CLI adds checks when "adds", not negated, leads to "check" or "checks" in it.
const ADDS_CHECKS = /(?<!\bnever )\badds\b(?!\s+(?:no|nothing)\b).*\bchecks?\b/;
const asWord = (name: string) => new RegExp(`(?<![\\w-])${escape(name)}(?![\\w-])`, "g");

// The sentences of a contract, in its `#` comments and its may_differ reasons, that say a participant
// adds checks, each checked against the fixture's goldens: the sentence names a check id, and that
// CLI's golden carries it while no other participant's does. The participant named last before "adds"
// is the one said to add them; a sentence that names none before it is about something else, and so is
// one whose subject has no golden. A claim that names no check id a golden carries cannot be checked,
// and is reported as such.
export function unbackedAdditionClaims(contractSource: string, fixture: CommittedFixture): string[] {
  const contract = parseYaml(contractSource) as { may_differ?: unknown } | null;
  const sentences = commentSentences(contractSource, "#").map(({ line, text }) => ({ where: `line ${line}`, text }));
  const entries: unknown[] = Array.isArray(contract?.may_differ) ? contract.may_differ : [];
  for (const raw of entries) {
    const entry = raw as { path?: unknown; reason?: unknown } | null;
    if (typeof entry?.reason !== "string") continue;
    const words = entry.reason.split(/\s+/).filter(Boolean).map((word) => ({ line: 0, word }));
    sentences.push(...sentencesOf(words).map(({ text }) => ({ where: `may_differ ${String(entry.path)} reason`, text })));
  }
  const ids = new Map(Object.entries(fixture.goldens).map(([cli, golden]) => [cli, goldenCheckIds(golden)] as const));
  const known = new Set([...ids.values()].flatMap((set) => [...set]));
  const unbacked: string[] = [];
  for (const { where, text } of sentences) {
    const addsAt = text.search(ADDS_CHECKS);
    if (addsAt < 0) continue;
    let subject: string | undefined;
    let subjectAt = -1;
    for (const cli of ids.keys()) {
      for (const match of text.slice(0, addsAt).matchAll(asWord(cli))) {
        const at = match.index ?? -1;
        if (at > subjectAt) {
          subjectAt = at;
          subject = cli;
        }
      }
    }
    if (subject === undefined) continue;
    const named = [...known].filter((id) => asWord(id).test(text));
    if (named.length === 0) unbacked.push(`${where}: ${subject} is said to add checks, but the sentence names no check id a golden carries: ${text}`);
    for (const id of named) {
      if (!ids.get(subject)?.has(id)) unbacked.push(`${where}: ${subject}'s golden does not carry ${id}, which the sentence says it adds: ${text}`);
      const others = [...ids].filter(([cli, set]) => cli !== subject && set.has(id)).map(([cli]) => cli);
      if (others.length > 0) unbacked.push(`${where}: ${others.join(", ")}'s golden carries ${id} too, which the sentence says ${subject} adds: ${text}`);
    }
  }
  return unbacked;
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

test("no contract says a CLI adds checks of its own unless it names a check its golden carries and the other goldens do not", () => {
  const fixtures = committedFixtures();
  assert.ok(fixtures.some((f) => Object.keys(f.goldens).length > 1), "expected fixtures/*/expected/*.json goldens");
  const problems = fixtures.flatMap((fixture) => {
    const path = join("fixtures", fixture.name, "contract.yaml");
    return unbackedAdditionClaims(readFileSync(join(repoRoot, path), "utf8"), fixture).map((p) => `${path} ${p}`);
  });
  assert.deepEqual(problems, [], "Name the check the CLI adds, as its golden alone carries it, or name only the version difference.");
});

test("an addition claim is checked against the goldens of its fixture: the named check is in the subject's golden and in no other", () => {
  const fixture: CommittedFixture = {
    name: "secure-dir",
    mustMatch: ["score"],
    goldens: {
      hma: { score: 0, findings: [{ checkId: "CRED-001" }], allFindings: [{ checkId: "CRED-001" }, { checkId: "PERM-001" }] },
      opena2a: { score: 0, findings: [{ checkId: "CRED-001" }, { checkId: "HYGIENE-001" }], allFindings: [{ checkId: "CRED-001" }, { checkId: "PERM-001" }, { checkId: "HYGIENE-001" }] },
    },
  };
  assert.deepEqual([...goldenCheckIds(fixture.goldens.opena2a)].sort(), ["CRED-001", "HYGIENE-001", "PERM-001"]);
  // a claim that names no check id is reported with the line of its comment, or the may_differ entry it is in
  const comment = "description: x\n# opena2a runs a bundled copy of the scanner,\n# and adds hygiene checks of its own. Nothing else.\n";
  const unbacked = unbackedAdditionClaims(comment, fixture);
  assert.equal(unbacked.length, 1, unbacked.join("\n"));
  assert.match(unbacked[0], /^line 2: opena2a is said to add checks, but the sentence names no check id a golden carries: opena2a runs /);
  const reason = 'may_differ:\n  - path: findings\n    reason: "Known drift. opena2a adds hygiene checks of its own, so the lists differ."\n';
  assert.match(unbackedAdditionClaims(reason, fixture).join("\n"), /^may_differ findings reason: opena2a is said to add checks, [^\n]*: opena2a adds hygiene checks of its own, so the lists differ\.$/);
  // a claim that names the check its golden alone carries holds
  assert.deepEqual(unbackedAdditionClaims("# opena2a adds HYGIENE-001, a check of its own.", fixture), []);
  // a named check the other golden carries too, or one the subject's golden lacks, is reported
  assert.match(unbackedAdditionClaims("# opena2a adds the CRED-001 check.", fixture).join("\n"), /^line 1: hma's golden carries CRED-001 too, which the sentence says opena2a adds: /);
  assert.match(unbackedAdditionClaims("# hma adds HYGIENE-001 checks.", fixture).join("\n"), /^line 1: hma's golden does not carry HYGIENE-001, which the sentence says it adds: /);
  // the participant named last before "adds" is the subject
  assert.deepEqual(unbackedAdditionClaims("# hma lacks what opena2a adds: HYGIENE-001 checks.", fixture), []);
  // a negated or past claim, one with no participant before "adds", and one about a CLI with no golden say nothing
  assert.deepEqual(unbackedAdditionClaims("# opena2a adds no check of its own.", fixture), []);
  assert.deepEqual(unbackedAdditionClaims("# opena2a added checks of its own until 0.10.", fixture), []);
  assert.deepEqual(unbackedAdditionClaims("# The bundled copy adds checks the other lacks.", fixture), []);
  assert.deepEqual(unbackedAdditionClaims("# ai-trust adds checks of its own.", fixture), []);
  // a `#` with no white space after it inside a block scalar is content, not a comment
  assert.deepEqual(unbackedAdditionClaims("description: >\n  opena2a\n  #458 adds checks of its own.\n", fixture), []);
});
