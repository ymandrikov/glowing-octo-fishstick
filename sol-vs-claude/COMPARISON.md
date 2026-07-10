# `lint-color/ast.ts` — SOL.patch vs CLAUDE.patch

Base: `lint-color/ast.ts` @ `369b72b` (219 lines, 24 comment lines).

Both patches are comment-cleanup passes. Neither changes control flow, types, or exported
signatures — every code path in the base file survives both. They differ in *how much
knowledge they delete* and in whether they also rename identifiers.

A third pass, `FABLE.patch`, arrived after this comparison was written. It does not change
the SOL-vs-CLAUDE analysis below; §7 compares it against each of them as a complement.

---

## 1. Scope

| | SOL.patch | CLAUDE.patch |
|---|---|---|
| Comments deleted outright | 21 of 24 | 8 of 24 |
| Comments rewritten (kept, tightened) | 3 | 10 |
| Comments added | 0 | 2 |
| Identifiers renamed | 18 | 0 |
| Behavior change | none | none |
| Diff footprint | ~65 changed lines | ~40 changed lines, comments only |

SOL does two jobs in one patch: comment stripping **and** a rename sweep. CLAUDE does one.

---

## 2. Identifier renames (SOL only)

`src`→`source`, `k`→`index`, `lo/hi/mid`→`lowerIndex/upperIndex/middleIndex`,
`cache`→`parseCache`, `Lang`→`ParserLanguage`, `langForFile`→`parserLanguageForFile`,
`rec`→`record`, `out`→`statics`, `c`→`comment`, `m`→`markerMatch`,
`COMMENT_DELIM_LEN`→`COMMENT_OPENING_LENGTH`, `obj`→`objectExpression`, `p`→`property`,
`e`→`expression`, `k`→`key`, `q`→`quasi`, `n`→`node`.

**For.** Several are real wins. `cache` → `parseCache` says what is cached. `langForFile`
→ `parserLanguageForFile` disambiguates from the natural-language sense of "lang". `obj`,
`e`, `rec` → full nouns cost nothing at these call sites.

**Against.**
- `lo/hi/mid` → `lowerIndex/upperIndex/middleIndex` in a 7-line binary search buys nothing.
  These are the canonical names for the algorithm; the long forms make the line
  `const middleIndex = (lowerIndex + upperIndex + 1) >> 1;` harder to read, not easier.
- `k` → `index` in a `for` loop is the same story.
- The renames are entangled with the comment deletions in one patch. If a reviewer wants
  the renames but not the deletions (or vice versa), they cannot take half.
- Rename churn on a file that four rule modules import is merge-conflict surface for any
  in-flight branch. None of the renames are of exported symbols, so the blast radius is
  contained to this file — but the diff noise is not.

---

## 3. Knowledge lost

This is the substantive difference. Judge each deleted comment by: *can the next reader
re-derive this from the code?*

### 3.1 Deleted by SOL, kept by CLAUDE — re-derivable, fine to lose either way

- `// Resolve a JSX element or attribute name node to its source string.` — the signature
  says this. CLAUDE also drops the sentence and keeps only the `<div>` → `"div"` examples.
- `// skip SpreadElement` on `if (p.type !== "Property") continue;` — the code says it.
  Both delete it.
- `// The typeof rec.type === "string" guard is what makes the cast to Node sound.` — a
  restatement of the line above it.

### 3.2 Deleted by SOL, kept by CLAUDE — **not** re-derivable

| Location | What SOL deletes | Why it matters |
|---|---|---|
| `walk`, `key === "parent"` | *"Skips the `parent` back-reference so the walk can't cycle."* | `parent` looks like a field you could safely descend into. Without the comment, deleting the guard is a plausible "simplification" that hangs the linter. CLAUDE moves this comment onto the guard line itself, which is stricter than the base. |
| `COMMENT_DELIM_LEN = 2` | *"`//` or `/*` — comment.value excludes the opener"* | SOL renames it `COMMENT_OPENING_LENGTH = 2` and deletes the comment, leaving a bare `2` justified only by its name. The load-bearing fact — that oxc's `comment.value` **excludes** the opener, which is why the offset needs adding back — is now nowhere in the file. Off-by-two in reported line numbers is the failure mode. CLAUDE keeps it. |
| `IGNORE_MARKER` | *"…a className like `color-lint-ignore-panel` no longer counts (fixes #18)"* | The `(?![-\w])` lookahead is opaque. The comment is the only record of the bug it fixes. Someone relaxing the regex to match `color-lint-ignore-next-line` regresses #18 silently. CLAUDE keeps a one-line version. |
| `classNameStatics` | *"Class strings reached through a call (cn/clsx), a ternary, or a logical expression are a deliberate v1 non-goal"* | **The most expensive deletion.** The function looks *incomplete*, not *deliberately shallow*. The obvious "fix" is to make it call `classNameStaticsDeep`, which is exactly the change that reintroduces the false-positive class the AST rewrite existed to kill. SOL deletes this entirely and leaves no marker. |
| `classNameStaticsDeep` | The `KNOWN v1 LIMITATION` block + `cn("flex", t("pick a text-red-500 tone"))` example + `PRD §2 Non-Goals` pointer | SOL replaces all of it with *"Scanning every nested string preserves legacy behavior but can inspect non-class arguments."* This states that a hazard exists without saying what it is, when it fires, or where the decision is recorded. A reader hitting a false positive in the wild has no thread to pull. |
| `styleObjectProps` | *"Detected via the object AST, not brace counting, so a `{` inside a string value can't desync anything (fixes #2 / M2)."* | Same shape as #18 — the only record of a fixed bug. CLAUDE drops the AST-vs-brace-counting sentence too, but keeps the behavioral contract (`style={expr}` yields `[]`), which the base comment also carried. |
| `propKeyName` | *"A computed key (`[dynamic]: …`) has no statically-known name."* | Explains why `p.computed && k.type !== "Literal"` is the condition rather than just `p.computed`. CLAUDE sharpens it: `` `[dynamic]: …` has no static name, but `["color"]: …` does. `` — that second clause is the whole reason for the `k.type !== "Literal"` half, and neither the base nor SOL states it. |
| `langForFile` | *"…which would silently drop the rest of the file. `tsx` and `ts` are not a superset relationship."* | SOL keeps one line: *"TSX mode misparses valid TypeScript generic arrows and angle-bracket assertions."* True, but it drops the **consequence** (silent truncation of the file) — which is what makes this a correctness guard rather than a style preference. |
| `parseSource` | The syntax-error-recovery rationale | SOL keeps *"Syntax errors belong to the compiler; lint continues with oxc's recovered tree."* This is a fair compression and loses little. |

### 3.3 File header

Base has a 6-line header. SOL deletes it. CLAUDE compresses to 3 lines, keeping the
invariant that matters — *rules walk the tree, never the text* — and dropping the
historical framing about the review that motivated it.

The invariant is the one thing in the header a new rule author needs. SOL's version of the
file does not state anywhere that text-scanning is forbidden.

---

## 4. Comments CLAUDE adds

Two, both moving a fact next to the code it constrains:

- `// `parent` is a back-reference; descending into it would cycle.` — attached to the
  `continue` guard rather than floating above the function.
- `// oxc's `comment.value` excludes the opening `//` or `/*`.` — promoted from a trailing
  comment to a line above `COMMENT_DELIM_LEN`, so it survives a rename of the constant.

---

## 5. Where CLAUDE is weaker

- It leaves `k`, `lo`, `hi`, `rec`, `out`, `q`, `p`, `e`, `m`, `c` untouched. `cache` and
  `langForFile` in particular are worth SOL's renames.
- It drops the `(fixes #2 / M2)` and `(fixes #18)` issue references while keeping the
  behavioral claims. Those pointers are cheap and are the only link from this file to the
  issue tracker.
- `// index.ts runs four rule passes over the same source; LRU(1) keeps it one parse.`
  hardcodes "four" — a count that rots. SOL deletes the comment entirely, which at least
  cannot go stale, though it also erases why an LRU(1) is sufficient. (FABLE threads this
  needle — see §7.)

---

## 6. Assessment

SOL applies a *density* rule: fewer comments is better. It is correct that the base file
over-comments — several of its 24 comment lines restate their code, and both patches
delete those. But SOL does not distinguish "restates the code" from "records a decision the
code cannot express." It deletes both classes at the same rate, and the second class
includes three bug fixes (`#18`, `#2`/`M2`, the `parent` cycle), one deliberate non-goal
(`classNameStatics` staying shallow), and one known limitation with a PRD cross-reference.

Those are exactly the comments worth keeping. The test in `docs/agents` terms: a comment
earns its line when it states a constraint the code cannot show. `(?![-\w])` cannot show
that it exists because a class named `color-lint-ignore-panel` once matched. A shallow
`collectClassStatics` cannot show that it is shallow on purpose.

CLAUDE applies that test and lands where the base file should have been: every surviving
comment states something the reader could not have derived, tightened to one or three
lines, and moved adjacent to the code it constrains.

**Recommendation.** Take CLAUDE.patch as the comment pass. Land SOL's renames separately,
narrowed to the ones that carry meaning:

- `cache` → `parseCache`
- `langForFile` → `parserLanguageForFile`, `Lang` → `ParserLanguage`
- `rec` → `record`, `obj` → `objectExpression`, `e` → `expression`

Skip the rest. `lo/hi/mid` in a binary search and `k` in a `for` loop are already the
clearest names available; expanding them adds width without adding information.

---

## 7. FABLE.patch — complementary comparison

Same base (`369b72b`), same genre as CLAUDE: comments only, zero renames, zero behavior
change. Counting by comment block (the base file has 16): FABLE deletes 6, rewrites 8,
keeps 2 verbatim, adds 0. That puts it between the other two on the delete/keep axis —
more willing to delete than CLAUDE, but it applies the same "decision the code cannot
express" test that SOL lacks. The primary SOL-vs-CLAUDE verdict in §6 is unaffected; what
follows is where FABLE agrees, where it improves on CLAUDE, and where it loses to it.

### 7.1 FABLE vs CLAUDE (same genre — the comparison that matters)

**Agreements.** Both keep every §3.2 headline item: the `classNameStatics` shallow-by-design
non-goal with the v1.1 allowlist pointer, the `KNOWN v1 LIMITATION` block with the i18n
example and the `PRD §2` reference, the `parent` cycle guard rationale, the
`COMMENT_DELIM_LEN` opener-exclusion fact, and the `IGNORE_MARKER` superstring example.
Both delete the same derivable narration (import-block ESTree note, `walk` cast note,
`// skip SpreadElement`). Both drop the `#18` / `#2 / M2` issue references — the §5
critique of CLAUDE applies to FABLE unchanged.

**Where FABLE is stronger.**

| Location | FABLE | CLAUDE |
|---|---|---|
| Parse cache | *"Rule passes re-enter with the same source; the size-1 cache makes that one parse per file."* — keeps the why-LRU(1)-suffices rationale with no count and no `index.ts` coupling. Directly resolves §5's staleness bullet. | Keeps *"index.ts runs four rule passes…"* — "four" rots. |
| `buildLineStarts` | Keeps *"oxc nodes carry byte offsets (Span), not 1-based lines"* verbatim — the external-API fact that explains why the line-table machinery exists at all. | Deletes it. The only pass of the three that keeps it. |
| `IGNORE_MARKER` | Keeps the line-scoping rationale (*"a multi-line comment that merely mentions the word can't swallow other lines"*). | Compresses to the superstring sentence only; the scoping decision goes unrecorded. |
| `classNameStatics` | Keeps the cross-pointer (*"classNameStaticsDeep below is the opt-in deep view"*) — the road sign that stops the "obvious fix" of deepening the shallow walker (§3.2's most-expensive-deletion scenario). | Drops the pointer; the reader must discover the deep sibling themselves. |

**Where CLAUDE is stronger.**

| Location | CLAUDE | FABLE |
|---|---|---|
| `langForFile` | Keeps *"silently drops the rest of the file"* — the consequence that makes this a correctness guard. | Drops it, the same loss §3.2 charges SOL with (FABLE's version still shows the misparse examples, so the loss is partial). |
| `propKeyName` | Sharpens to `` `[dynamic]: …` has no static name, but `["color"]: …` does `` — the only version of the file that explains the `k.type !== "Literal"` half of the condition. | Deletes the comment, as SOL does. |
| `styleObjectProps` | Keeps the behavioral contract (`style={expr}` yields `[]`). | Deletes the whole block, contract included. |
| `jsxName` | Keeps the `<div>` → `"div"` / `<Dialog.Trigger>` examples. | Deletes them. Cheap loss — the switch is short — but the examples cost one line. |
| Comment placement | Moves facts adjacent to the code they constrain (cycle note onto the guard line, delimiter fact above the constant). | Leaves both at their base positions. |

### 7.2 FABLE vs SOL

Not really a contest — SOL's distinguishing move is the rename sweep, which FABLE doesn't
attempt, so the §2 analysis has no FABLE counterpart. On comments, FABLE keeps four of the
knowledge items §3.2 shows SOL destroying (shallow non-goal, KNOWN LIMITATION + PRD ref,
`parent` cycle, delimiter fact) and shares three of SOL's cheaper losses (`propKeyName`
computed-key note, the `styleObjectProps` block, the `langForFile` silent-truncation
consequence). FABLE also keeps a 3-line version of the file header stating the
tree-not-text invariant, which §3.3 flags as SOL's structural omission.

### 7.3 Effect on the recommendation

Unchanged in shape: **CLAUDE.patch is still the comment pass to take**, and SOL's renames
still land separately per §6. FABLE's contribution is two cherry-picks to graft onto
CLAUDE.patch:

- FABLE's cache comment, replacing CLAUDE's stale-prone *"four rule passes"* line.
- FABLE's kept `buildLineStarts` byte-offset note (and, lower value, the `IGNORE_MARKER`
  line-scoping sentence and the `classNameStatics` → deep-view cross-pointer).

Everything else FABLE does either matches CLAUDE or deletes something CLAUDE rightly keeps.
