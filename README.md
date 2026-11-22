# mend

`mend` is a command-line tool that applies an edit an AI model wrote to a tree of text files. Models write
edits in four formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch
format, and text-editor tool calls as JSON — and mend reads all four to one written specification, `SPEC.md`,
which is the whole contract for its behaviour.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

The working directory is the root of the tree; every path in a patch is relative to it. `PATCH` is the patch
file; when it is absent or `-`, the patch is read from standard input. `--format` names one format
(`unified`, `search-replace`, `v4a`, `json`); the default, `auto`, detects it. `--check` does everything but
write. `--strict` matches lines exactly.

mend finds the lines each edit names at the first of three matching tiers — exact, then ignoring trailing
whitespace, then ignoring leading and trailing whitespace — and writes every change or none. It prints one
line per changed path (`A`, `D`, `M`, or `R <old> -> <new>` for a move) and an `ok:` summary, one
`error: <code> <path>` line per failed edit and a `failed:` summary, or a single `error:` line with exit
code 2 for a usage, missing-patch, format or parse failure.

## Layout

- `main.ts` — the CLI itself (Node 22, standard library only).
- `SPEC.md` — the specification mend implements.
- `check.ts` and `runner.ts` — the kit's practice harness: `check.ts` runs `main.ts` on the public practice
  checks; in a make.fun trial `main.ts` hands over to `runner.ts` when `MAKEFUN_ENV_URL` is set.

## Testing

Run the practice set (100 checks: unified diffs, SEARCH/REPLACE blocks, V4A patches, JSON edits and
command-line behaviour) from the kit:

    node check.ts <path to the kit>/program/generator/practice.json

It prints every check that differs from the expected exit code, stdout and files, then the score.
