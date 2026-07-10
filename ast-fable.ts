// AST layer — the single boundary between raw TSX/TS source and every rule.
// Rules walk the parse tree instead of the text, so error messages, URLs, and
// comments are never mistaken for class lists.

import { parseSync } from "oxc-parser";
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

// Rule passes re-enter with the same source; the size-1 cache makes that one
// parse per file.
let cache: { source: string; lang: Lang; ast: ParsedAst } | null = null;

// `.ts` must NOT parse as tsx — under tsx mode a legal plain-TS generic arrow
// (`const f = <T>(x) => x`) or angle-bracket cast (`<Foo>bar`) is a parse error.
function langForFile(filePath: string): Lang {
  return /\.(tsx|jsx)$/.test(filePath) ? "tsx" : "ts";
}

export function parseSource(source: string, filePath = "file.tsx"): ParsedAst {
  const lang = langForFile(filePath);
  if (cache && cache.source === source && cache.lang === lang) return cache.ast;
  // On a syntax error oxc returns a best-effort recovered program; we walk what
  // parsed rather than surface `errors`, so an unparseable file lints as clean.
  // Deliberate for v1: the compiler flags real syntax errors.
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
  const rec = node as Record<string, unknown>;
  if (typeof rec.type === "string") enter(node as Node);
  for (const key in rec) {
    if (key === "parent" || key === "type") continue;
    const value = rec[key];
    if (value && typeof value === "object") walk(value, enter);
  }
}

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

// Lookahead rejects superstrings like "color-lint-ignore-panel". Suppression
// covers only the marker's physical line, so a multi-line comment that merely
// mentions the word can't swallow other lines.
const IGNORE_MARKER = /color-lint-ignore(?![-\w])/;
const COMMENT_DELIM_LEN = 2; // comment.value excludes the `//` or `/*` opener

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

// Shallow by design: plain string literals and template quasis only. Class
// strings behind a call (cn/clsx), ternary, or logical expression are a
// deliberate v1 non-goal (callee allowlist arrives in v1.1);
// classNameStaticsDeep below is the opt-in deep view.
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

// Deep view for no-component-color-override: every static string reachable in
// the value, descending into call arguments (cn/clsx/…).
//
// KNOWN v1 LIMITATION: without a callee allowlist this also collects non-class
// strings — e.g. an i18n argument like `cn("flex", t("pick a text-red-500
// tone"))` can false-fire. Bounded by the v1.1 callee allowlist; see PRD §2.
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

export function styleObjectProps(attrValue: Node | null | undefined): StyleProp[] {
  const obj = objectExpressionOf(attrValue);
  if (!obj) return [];
  const props: StyleProp[] = [];
  for (const p of obj.properties) {
    if (p.type !== "Property") continue;
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
  if (p.computed && k.type !== "Literal") return null;
  if (k.type === "Identifier") return k.name;
  if (k.type === "Literal") return typeof k.value === "string" ? k.value : null;
  return null;
}
