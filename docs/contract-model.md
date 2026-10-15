# Contract model

`contract.yaml` per fixture. Fields:

- `kind` — `directory` (the default) or `package-name`. A `directory` fixture has an `input/`
  directory, and each command is run with its path as the last argument. A `package-name` fixture
  has none: every `{PACKAGE}` in a command stands for the contract's `package`, a string. Any other
  `kind` fails the fixture before any CLI runs, and so does a `package` that is not a string in a
  `package-name` fixture; a `directory` fixture does not read `package`
- `exercises` — which CLI commands the fixture runs, a mapping from each participant to its command string, where every `{BIN}` stands for the command that runs that CLI (`HMA_BIN`, `OPENA2A_BIN` or `AI_TRUST_BIN`)
- `participants` — list of CLIs (`hma`, `opena2a`, `ai-trust`) for which a golden exists, each listed once. Every other CLI is skipped and needs a sentinel file, `expected/<cli>.skip`, saying why it does not exercise the fixture; a CLI that is neither a participant nor covered by a sentinel fails the fixture, and so does an empty sentinel. A list that names no CLI would run and compare nothing, and fails the fixture before any CLI runs, as does a CLI listed twice
- `must_match` — list of keys equal across participating CLIs apart from object key order. A key is
  a dot-separated path, with a numeric segment for an array index (`findings.0.checkId`, not
  `findings[0].checkId`). A key that resolves in no participant's golden fails the fixture, since it
  would compare nothing. A participant whose golden carries none of the `must_match` keys fails the
  fixture too: its leg would compare nothing, whatever its CLI prints. A `must_match` that lists no
  key compares nothing too, and fails the fixture before any CLI runs, as does an entry that is not
  a key string (`1`, `null`)
- `may_differ` — list of `{ path, reason }` entries naming keys per-CLI variation is allowed on.
  The harness fails the fixture before running any CLI if an entry has no `reason`, or if its
  `path` is also listed under `must_match` (a key there is compared whatever `may_differ` says)
- `normalize` — rules applied to CLI output before diffing (timestamps, absolute paths, tmp dirs).
  A rule is `strip_key` with a `path`, or `replace_regex` with a `pattern` (a regular expression,
  where every `{FIXTURE_INPUT_DIR}` stands for the fixture's input directory, matched literally; a
  `kind: package-name` fixture has none) and a `replacement`

A `contract.yaml` that is not one valid YAML document (a syntax error, a second document, a
repeated key) or that is not a mapping fails the fixture before any CLI runs, and the run goes on
to the next fixture. So do an `exercises` that is not a mapping or that maps a CLI to a number,
list or mapping, a `participants` entry that names no CLI, and a `normalize` rule with a numeric
`path` or a `pattern` that is empty or not a regular expression the engine can run with the input
directory in place of `{FIXTURE_INPUT_DIR}` (`[a-{FIXTURE_INPUT_DIR}]` is not one, and neither is
one too large to compile). So does a `pattern` that holds `{FIXTURE_INPUT_DIR}` in a
`kind: package-name` fixture, which has no input directory for it to stand for: with an empty
string there, `{FIXTURE_INPUT_DIR}*` would be `*`, which is not a regular expression,
`(?:{FIXTURE_INPUT_DIR})` would be `(?:)`, which matches at every position of every string, and
`{FIXTURE_INPUT_DIR}.*` with an empty `replacement` would delete every string value. So does a
`pattern` that holds `{FIXTURE_INPUT_DIR}` and can match empty text with the input directory
there, unless its `replacement` is empty, which inserts nothing: `({FIXTURE_INPUT_DIR})?` matches
the empty string, and `\b|{FIXTURE_INPUT_DIR}` matches empty text next to each word. An assertion
(`^`, `$`, `\b`, `\B` or a lookaround) counts as able to match empty text whatever it asserts.

A golden that is not valid JSON, that is not a file (a directory or a FIFO), or that cannot be
opened (a file without read permission, or a symbolic link that dangles or loops) fails its
participant's leg without running that CLI, and the run goes on to the remaining legs and
fixtures. A `contract.yaml` that is a directory, a FIFO, a file without read permission or a
symbolic link that dangles or loops fails its fixture before any CLI runs, a skip sentinel that is
a directory, a FIFO or a file without read permission fails its fixture as an empty one does, and
a capture whose path under `actual/` is not a file (a directory, a FIFO or a device) or that
cannot be written (its fixture's directory there is a file) fails its participant's leg. So does
an output that a `pattern` cannot be run on when it is normalized: the engine can compile the
pattern again there, deeper in the call stack than the load check, and a pattern near its compile
stack limit then fails to compile.

See `fixtures/secure-dirty-skill/contract.yaml` for the first fixture.

A `must_match` key is checked twice. Each CLI's output is compared with that CLI's own golden,
and then the CLIs are compared with each other: the goldens of the participating CLIs, and their
outputs, hold the same value for the key. A CLI whose golden omits a key is left out of that
key's comparison between CLIs, and its output must omit the key too. A fixture whose goldens disagree on a `must_match` key fails even when
every CLI matches its own golden. If the CLIs differ on purpose, move the key from `must_match`
to `may_differ`, with the reason.

An `error` in a CLI's output is checked against that CLI's own golden, after normalization,
even where the contract lists `error` under `may_differ` (which lets the wording differ between
CLIs). An error the golden does not record is tried up to three times (two retries), and if it
still differs after the last attempt the leg fails. On `check-not-found`, ai-trust's registry timeout carries
the same `name`, `found` and `ecosystem` as a real not-found, so the error is what tells them
apart. hackmyagent's payload for an unreachable registry (a timeout, a 5xx and a network error
share one payload) carries `name` and `found: false` but no `ecosystem`, so its leg fails as a
`[SHAPE]` failure naming the absent key instead of through the error comparison. A CLI that
rewords its error on purpose re-baselines its golden first, like any other intended output
change; if the rewording was not intended, it is a CLI regression and the golden stays as it is.
