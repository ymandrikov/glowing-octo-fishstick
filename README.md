# sol-vs-claude — comment-cleanup comparison

Three independent comment-cleanup passes over the same file, compared.

The subject is `ast.ts` from a design-system linter (`lint-color`, base revision
`369b72b`) — the AST layer between oxc-parsed TSX/TS source and the lint rules. The base
file carries 24 comment lines mixing derivable narration with decision records (deliberate
non-goals, fixed-bug rationale, external-API facts). Each pass was asked to clean the
comments aggressively; they disagree about what to keep.

**Read the comparison:**

- Rendered: <https://ymandrikov.github.io/glowing-octo-fishstick/comparison.html>
- Markdown: [COMPARISON.md](COMPARISON.md)

## Files

| File | What it is |
|---|---|
| [`ast.ts`](ast.ts) | Base file, untouched |
| [`SOL.patch`](SOL.patch) / [`ast-sol.ts`](ast-sol.ts) | Pass 1: deletes 21 of 24 comment lines, plus an 18-identifier rename sweep |
| [`CLAUDE.patch`](CLAUDE.patch) / [`ast-claude.ts`](ast-claude.ts) | Pass 2: comments only — deletes 8, rewrites 10, adds 2 |
| [`FABLE.patch`](FABLE.patch) / [`ast-fable.ts`](ast-fable.ts) | Pass 3: comments only, between the other two in aggressiveness |
| [`COMPARISON.md`](COMPARISON.md) | The write-up: SOL vs CLAUDE as the main pair (§1–6), FABLE as a complement (§7) |
| [`comparison.html`](comparison.html) | Same analysis as a standalone page |
| [`SKILL.md`](SKILL.md) | The clean-code-comments skill the passes were judged against |

Each `ast-*.ts` is its patch applied independently to the base — the patches share one
base revision, so they don't stack.

## Verdict (short version)

SOL optimizes comment *density* and deletes decision records at the same rate as
narration. CLAUDE applies the test from `SKILL.md` — keep a comment only when it states a
constraint the code cannot show — and lands closest to right. FABLE agrees with CLAUDE on
every headline keep, fixes CLAUDE's one stale comment, but drops a few contracts CLAUDE
rightly kept. Recommendation: CLAUDE.patch as the comment pass, a narrowed subset of SOL's
renames separately, two cherry-picks from FABLE. Details in the comparison.
