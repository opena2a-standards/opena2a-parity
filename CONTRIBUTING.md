# Contributing

To add a fixture, follow [docs/adding-a-fixture.md](docs/adding-a-fixture.md). To change a golden after an intended CLI output change, follow [docs/re-baselining-goldens.md](docs/re-baselining-goldens.md).

## Layout

```
src/run-parity.ts                    harness (Node 24, --experimental-strip-types)
fixtures/
  secure-dirty-skill/
    input/                           directory under test (a deliberately insecure sample project)
    contract.yaml                    must-match / may-differ rules for this fixture
    expected/
      hma.json                       golden output
      opena2a.json                   golden output
      ai-trust.skip                  sentinel: ai-trust does not exercise this fixture
```
