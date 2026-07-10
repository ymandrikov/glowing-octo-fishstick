// AST layer — the single boundary between raw TSX/TS source and every rule.
//
// One oxc parse per file replaces the hand-rolled JSX scanning that treated
// every quoted string as a className. Rules walk this tree instead of the text,
// so error messages, URLs, GraphQL/regex literals, and comments are never
// mistaken for class lists (root cause of the review's dominant FP class).

import { parseSync } from "oxc-parser";
// AST-node types are re-exported by oxc-parser from @oxc-project/types; they are
// ESTree-shaped, so the `.type` discriminants below ("Literal", "Property", …)
// are the runtime string values, not the interface names.
import type {
  Program,
  Comment,
  Node,
  ObjectExpression,
  ObjectProperty,
  JSXElementName,
  Expression,
} from "oxc-parser";

export type ParsedAst = {
  program: Program;
  comments: Comment[];
  lineStarts: number[];
  ignored: Set<number> | null;
};

export type ClassStatic = { text: string; node: Node };

export type StyleProp = { keyName: string; valueNode: Expression; node: ObjectProperty };

type Lang = "tsx" | "ts";

// oxc nodes carry byte offsets (Span), not 1-based lines.
export function buildLineStarts(src: string): number[] {
  const starts = [0];
  for (let k = 0; k < src.length; k++) {
    if (src[k] === "\n") starts.push(k + 1);
  }
  return starts;
}

export function offsetToLine(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

// index.ts runs four rule passes over the same source; the LRU(1) cache makes
// that one parse per file.
let cache: { source: string; lang: Lang; ast: ParsedAst } | null = null;

// `.tsx` parses JSX; `.ts` must NOT — under tsx mode a legal plain-TS generic
// arrow (`const f = <T>(x) => x`) or angle-bracket cast (`<Foo>bar`) is a parse
// error, which would silently drop the rest of the file. `tsx` and `ts` are not
// a superset relationship, so pick by extension.
function langForFile(filePath: string): Lang {
  return /\.(tsx|jsx)$/.test(filePath) ? "tsx" : "ts";
}

export function parseSource(source: string, filePath = "file.tsx"): ParsedAst {
  const lang = langForFile(filePath);
  if (cache && cache.source === source && cache.lang === lang) return cache.ast;
  // On a syntax error oxc returns a best-effort recovered program; we walk what
  // parsed rather than surface `errors`. A genuinely unparseable file therefore
  // lints as clean — acceptable for v1 (the compiler flags real syntax errors),
  // and the lang-by-extension choice above keeps valid TS/TSX from tripping it.
  const { program, comments } = parseSync(filePath, source, { lang });
  const ast: ParsedAst = { program, comments, lineStarts: buildLineStarts(source), ignored: null };
  cache = { source, lang, ast };
  return ast;
}

// Skips the `parent` back-reference so the walk can't cycle.
export function walk(node: unknown, enter: (node: Node) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, enter);
    return;
  }
  // The `typeof rec.type === "string"` guard is what makes the cast to Node sound.
  const rec = node as Record<string, unknown>;
  if (typeof rec.type === "string") enter(node as Node);
  for (const key in rec) {
    if (key === "parent" || key === "type") continue;
    const value = rec[key];
    if (value && typeof value === "object") walk(value, enter);
  }
}

// Resolve a JSX element or attribute name node to its source string.
// `<div>` → "div", `<Dialog.Trigger>` → "Dialog.Trigger", `<svg:a>` → "svg:a".
export function jsxName(node: JSXElementName | null | undefined): string {
  if (!node) return "";
  switch (node.type) {
    case "JSXIdentifier":
      return node.name;
    case "JSXNamespacedName":
      return `${node.namespace.name}:${node.name.name}`;
    case "JSXMemberExpression":
      return `${jsxName(node.object)}.${node.property.name}`;
    default:
      return "";
  }
}

// Only the exact marker word in a *comment* suppresses — a className like
// "color-lint-ignore-panel" no longer counts (fixes #18 superstring match).
// Suppression is scoped to the physical line the marker sits on, so a multi-line
// comment that merely mentions the word can't swallow other lines.
const IGNORE_MARKER = /color-lint-ignore(?![-\w])/;
const COMMENT_DELIM_LEN = 2; // `//` or `/*` — comment.value excludes the opener

export function ignoredLines(ast: ParsedAst): Set<number> {
  if (ast.ignored) return ast.ignored;
  const lines = new Set<number>();
  for (const c of ast.comments) {
    const m = IGNORE_MARKER.exec(c.value);
    if (!m) continue;
    const markerOffset = c.start + COMMENT_DELIM_LEN + m.index;
    lines.add(offsetToLine(ast.lineStarts, markerOffset));
  }
  ast.ignored = lines;
  return lines;
}

// Static class strings carried by a className/class attribute value, each with
// the node whose offset locates it. v1 scans a plain string literal and a
// template literal's static quasis only. Class strings reached through a call
// (cn/clsx), a ternary, or a logical expression are a deliberate v1 non-goal —
// the general token pipeline stays "bare className/class" so no non-class string
// is ever scanned; those shapes return with the callee allowlist in v1.1.
// (no-component-color-override opts into the deep view below for cn()/clsx().)
export function classNameStatics(value: Node | null | undefined): ClassStatic[] {
  const out: ClassStatic[] = [];
  collectClassStatics(value, out);
  return out;
}

function collectClassStatics(node: Node | null | undefined, out: ClassStatic[]): void {
  if (!node) return;
  if (node.type === "Literal" && typeof node.value === "string") {
    out.push({ text: node.value, node });
  } else if (node.type === "JSXExpressionContainer") {
    collectClassStatics(node.expression, out);
  } else if (node.type === "TemplateLiteral") {
    for (const q of node.quasis) {
      out.push({ text: q.value.cooked ?? q.value.raw ?? "", node: q });
    }
  }
}

// Every static string reachable inside a className value, descending into call
// arguments (cn/clsx/…) and any nested expression. no-component-color-override
// needs this deep view to catch color classes wrapped in a helper; the general
// token pipeline deliberately stays shallow (v1 non-goal).
//
// KNOWN v1 LIMITATION: without a callee allowlist this also collects strings
// that are not class lists — an i18n/aria argument nested in the expression
// (e.g. `cn("flex", t("pick a text-red-500 tone"))`) is tokenized and can false-
// fire on a watched component. This matches the pre-AST behavior and is bounded
// by the v1.1 callee allowlist (cn/clsx/cva/tw``); see PRD §2 Non-Goals.
export function classNameStaticsDeep(value: unknown): ClassStatic[] {
  const out: ClassStatic[] = [];
  walk(value, (n) => {
    if (n.type === "Literal" && typeof n.value === "string") {
      out.push({ text: n.value, node: n });
    } else if (n.type === "TemplateElement") {
      out.push({ text: n.value.cooked ?? n.value.raw ?? "", node: n });
    }
  });
  return out;
}

// Own properties of a style object literal, as { keyName, valueNode, node }.
// Detected via the object AST, not brace counting, so a `{` inside a string
// value can't desync anything (fixes #2 / M2). Returns [] for style={expr}.
export function styleObjectProps(attrValue: Node | null | undefined): StyleProp[] {
  const obj = objectExpressionOf(attrValue);
  if (!obj) return [];
  const props: StyleProp[] = [];
  for (const p of obj.properties) {
    if (p.type !== "Property") continue; // skip SpreadElement
    const keyName = propKeyName(p);
    if (keyName == null) continue;
    props.push({ keyName, valueNode: p.value, node: p });
  }
  return props;
}

function objectExpressionOf(attrValue: Node | null | undefined): ObjectExpression | null {
  if (!attrValue || attrValue.type !== "JSXExpressionContainer") return null;
  let e: Node = attrValue.expression;
  while (
    e &&
    (e.type === "TSAsExpression" ||
      e.type === "TSSatisfiesExpression" ||
      e.type === "ParenthesizedExpression")
  ) {
    e = e.expression;
  }
  return e && e.type === "ObjectExpression" ? e : null;
}

function propKeyName(p: ObjectProperty): string | null {
  const k = p.key;
  if (!k) return null;
  // A computed key (`[dynamic]: …`) has no statically-known name.
  if (p.computed && k.type !== "Literal") return null;
  if (k.type === "Identifier") return k.name;
  if (k.type === "Literal") return typeof k.value === "string" ? k.value : null;
  return null;
}
