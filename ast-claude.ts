// The single boundary between raw TSX/TS source and every rule. Rules walk this
// tree, never the text, so URLs, error messages, and regex/GraphQL literals are
// never mistaken for class lists.

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

// index.ts runs four rule passes over the same source; LRU(1) keeps it one parse.
let cache: { source: string; lang: Lang; ast: ParsedAst } | null = null;

// tsx is not a superset of ts. Under tsx mode a legal plain-TS generic arrow
// (`const f = <T>(x) => x`) or angle-bracket cast (`<Foo>bar`) is a parse error,
// which silently drops the rest of the file.
function langForFile(filePath: string): Lang {
  return /\.(tsx|jsx)$/.test(filePath) ? "tsx" : "ts";
}

export function parseSource(source: string, filePath = "file.tsx"): ParsedAst {
  const lang = langForFile(filePath);
  if (cache && cache.source === source && cache.lang === lang) return cache.ast;
  // oxc recovers from syntax errors into a partial program. We walk it and ignore
  // `errors`, so an unparseable file lints as clean — the compiler flags those.
  const { program, comments } = parseSync(filePath, source, { lang });
  const ast: ParsedAst = { program, comments, lineStarts: buildLineStarts(source), ignored: null };
  cache = { source, lang, ast };
  return ast;
}

export function walk(node: unknown, enter: (node: Node) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, enter);
    return;
  }
  const rec = node as Record<string, unknown>;
  if (typeof rec.type === "string") enter(node as Node);
  for (const key in rec) {
    // `parent` is a back-reference; descending into it would cycle.
    if (key === "parent" || key === "type") continue;
    const value = rec[key];
    if (value && typeof value === "object") walk(value, enter);
  }
}

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

// The lookahead stops a class name like "color-lint-ignore-panel" from matching.
const IGNORE_MARKER = /color-lint-ignore(?![-\w])/;
// oxc's `comment.value` excludes the opening `//` or `/*`.
const COMMENT_DELIM_LEN = 2;

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

// Strings reached through a call (cn/clsx), a ternary, or a logical expression
// are a deliberate v1 non-goal: staying shallow guarantees no non-class string is
// ever scanned. The v1.1 callee allowlist covers those shapes.
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

// Descends into call arguments and nested expressions, which only
// no-component-color-override wants — it must see color classes wrapped in a
// cn()/clsx() helper.
//
// KNOWN v1 LIMITATION: with no callee allowlist this also collects strings that
// are not class lists, so a nested i18n argument (`cn("flex", t("a text-red-500
// tone"))`) can false-fire on a watched component. Bounded by the v1.1 callee
// allowlist; see PRD §2 Non-Goals.
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

// Empty unless the attribute value is an object literal — `style={expr}` yields [].
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
  // `[dynamic]: …` has no static name, but `["color"]: …` does.
  if (p.computed && k.type !== "Literal") return null;
  if (k.type === "Identifier") return k.name;
  if (k.type === "Literal") return typeof k.value === "string" ? k.value : null;
  return null;
}
