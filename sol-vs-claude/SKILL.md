---
name: clean-code-comments
description: Use when an AI coding assistant writes, edits, or reviews code and must decide whether comments should be added, kept, rewritten, replaced by better names or types, or deleted; also when the user asks to fix, clean up, remove, reduce, audit, or review code comments.
---

# Clean Code Comments

Names first. Types second. Comments only when the code cannot carry the
reason by itself.

This skill has two jobs:

- Keep generated code from gaining useless comments.
- Clean existing comments on demand, usually by deleting them.

## Core Rule

Default to no comment.

Before writing or keeping a comment, try these in order:

1. Rename the variable, function, class, branch, test, or fixture.
2. Strengthen the type, signature, assertion, or schema.
3. Extract a helper only when the helper names a real concept and does not
   fragment a cohesive sequence.
4. Keep or write the comment only when it explains a non-local why.

Delete comments that narrate nearby code, restate names, explain normal
language behavior, summarize obvious control flow, or describe a type that
the signature can express.

Keep comments that carry information the code cannot express: protocol
quirks, external API behavior, historical compatibility constraints,
security or privacy rationale, performance tradeoffs, migration constraints,
and domain facts that are not inferable from local code.

## While Writing Code

Treat comments as opt-in. Do not add comment scaffolding while coding.

Do not write:

- Roadmap comments for code you are about to write.
- Section labels that repeat function names or file structure.
- Comments explaining standard library calls, syntax, loops, branches, or
  assignments.
- "Helper", "utility", "main logic", "handle error", "set up", or
  "initialize" comments.
- Examples unless the example is verified against the real code path and
  adds information the test suite or type system does not.

Before finishing any code-writing task:

1. Scan every comment added or touched in the diff.
2. Classify each one as `delete`, `rename`, `type`, `rewrite`, `keep`, or
   `flag`.
3. Delete the default filler.
4. Prefer a better name, type, assertion, or test over a rewritten comment.
5. Rewrite surviving comments to explain why this code is unusual here.

## Comment Cleanup

When asked to fix, clean up, review, or remove comments, edit the code
directly.

Use these verdicts internally:

- `delete`: the comment restates names, types, tests, control flow, or the
  nearby implementation.
- `rename`: better naming or a small extraction makes the comment unnecessary.
- `type`: a signature, type, schema, assertion, or docstring contract should
  replace prose.
- `rewrite`: the comment contains a real why, but says it badly or mixes it
  with obvious what.
- `keep`: the comment already earns its place.
- `flag`: the comment exposes a behavior bug, stale design assumption, missing
  context, or risky ambiguity outside the comment-cleanup scope.

Process:

1. Walk comments in the requested files or changed diff.
2. Classify before editing when the file has many comments or the risk is
   high; otherwise classify as you edit.
3. Prefer `delete`, `rename`, and `type` over `rewrite`.
4. Do not change runtime behavior unless the user asked for broader
   refactoring.
5. If a real why has no good local home, move it to the nearest useful
   documentation only when that documentation already exists; otherwise keep a
   short local why and flag the missing home.
6. Run the relevant formatter, linter, or tests when comment edits touch code
   structure. A cleanup that breaks the build is not done.

## Protected Comments

Do not judge or remove comments with external force unless the user explicitly
asks for that exact class of comment:

- License headers and copyright notices.
- Generated-file markers.
- Lint, compiler, coverage, formatting, bundler, or type-checker directives.
- Pragmas and magic comments.
- `@ts-expect-error`, `eslint-disable`, `rubocop:disable`, `istanbul ignore`,
  and similar tool controls.
- Ticketed `TODO`, `FIXME`, `HACK`, or migration notes.
- Public API docs, published package docs, doctests, and examples consumed by
  users.
- Region markers or comment anchors used by tooling.
- Security, audit, or compliance notes.

Protected does not mean good. It means do not casually delete it during comment
cleanup.

## Rewrite Standard

Write for someone who was not present and may not be a native speaker.

Use short, plain sentences. Explain the local reason, not the general concept.

Prefer:

```ts
// Stripe sends amounts in cents.
```

Over:

```ts
// Convert the amount to the smallest currency unit before sending it to the
// payment provider.
```

Prefer deleting both when the type or name can say it:

```ts
const amountInCents = dollarsToCents(amount);
```

## Dispute Test

Use a subagent test only for a genuinely disputed, load-bearing-looking
comment. Do not use it for ordinary obvious comments.

Protocol:

1. Show the subagent the stripped code only, without the comment or your
   hypothesis.
2. Ask what the code does and what it had to guess.
3. Keep only the information it could not recover from names, types, tests,
   and nearby code.
4. If the result still feels risky, keep the shortest why comment and add a
   flag in the final response.

## Final Response

For normal code-writing tasks, mention comment cleanup only if a notable
comment decision affected the implementation.

For explicit comment-cleanup tasks, summarize:

- Comments deleted.
- Comments replaced by names, types, assertions, or docstrings.
- Comments rewritten or kept for real why.
- Flags that need human judgment.

Do not print a per-comment ledger unless the user asks for audit detail.
