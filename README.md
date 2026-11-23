# mend — one patch tool for every AI edit format

[![hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/lively-raven-87/mend-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/lively-raven-87/mend-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

A command-line tool that applies a patch written in any of the four
formats AI editors emit — unified diffs, SEARCH/REPLACE blocks, V4A
patches, and JSON tool-call edits — to the directory it runs in. It
finds the lines each edit names with three tiers of whitespace
tolerance, and writes every change or none at all.

Entered on [make.fun](https://make.fun/?ref=200tdmdd&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards

## What's here

- `main.ts` — the tool (Node 22, standard library only). Run
  `node main.ts [options] [PATCH]`; see `SPEC.md` in the kit for the
  full contract.
- `runner.ts` — the kit's trial hand-over, unchanged.

## Run

```sh
node main.ts patch.diff        # apply a patch file
cat patch.diff | node main.ts  # or from stdin
node main.ts --check patch.diff  # report without writing
```
