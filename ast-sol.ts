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

type ParserLanguage = "tsx" | "ts";

export function buildLineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

export function offsetToLine(lineStarts: number[], offset: number): number {
  let lowerIndex = 0;
  let upperIndex = lineStarts.length - 1;
  while (lowerIndex < upperIndex) {
    const middleIndex = (lowerIndex + upperIndex + 1) >> 1;
    if (lineStarts[middleIndex] <= offset) lowerIndex = middleIndex;
    else upperIndex = middleIndex - 1;
  }
  return lowerIndex + 1;
}

let parseCache: { source: string; language: ParserLanguage; ast: ParsedAst } | null = null;

// TSX mode misparses valid TypeScript generic arrows and angle-bracket assertions.
function parserLanguageForFile(filePath: string): ParserLanguage {
  return /\.(tsx|jsx)$/.test(filePath) ? "tsx" : "ts";
}

export function parseSource(source: string, filePath = "file.tsx"): ParsedAst {
  const language = parserLanguageForFile(filePath);
  if (parseCache && parseCache.source === source && parseCache.language === language) {
    return parseCache.ast;
  }
  // Syntax errors belong to the compiler; lint continues with oxc's recovered tree.
  const { program, comments } = parseSync(filePath, source, { lang: language });
  const ast: ParsedAst = { program, comments, lineStarts: buildLineStarts(source), ignored: null };
  parseCache = { source, language, ast };
  return ast;
}

export function walk(node: unknown, enter: (node: Node) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, enter);
    return;
  }
  const record = node as Record<string, unknown>;
  if (typeof record.type === "string") enter(node as Node);
  for (const key in record) {
    if (key === "parent" || key === "type") continue;
    const value = record[key];
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

const IGNORE_MARKER = /color-lint-ignore(?![-\w])/;
const COMMENT_OPENING_LENGTH = 2;

export function ignoredLines(ast: ParsedAst): Set<number> {
  if (ast.ignored) return ast.ignored;
  const lines = new Set<number>();
  for (const comment of ast.comments) {
    const markerMatch = IGNORE_MARKER.exec(comment.value);
    if (!markerMatch) continue;
    const markerOffset = comment.start + COMMENT_OPENING_LENGTH + markerMatch.index;
    lines.add(offsetToLine(ast.lineStarts, markerOffset));
  }
  ast.ignored = lines;
  return lines;
}

export function classNameStatics(value: Node | null | undefined): ClassStatic[] {
  const statics: ClassStatic[] = [];
  collectClassStatics(value, statics);
  return statics;
}

function collectClassStatics(node: Node | null | undefined, statics: ClassStatic[]): void {
  if (!node) return;
  if (node.type === "Literal" && typeof node.value === "string") {
    statics.push({ text: node.value, node });
  } else if (node.type === "JSXExpressionContainer") {
    collectClassStatics(node.expression, statics);
  } else if (node.type === "TemplateLiteral") {
    for (const quasi of node.quasis) {
      statics.push({ text: quasi.value.cooked ?? quasi.value.raw ?? "", node: quasi });
    }
  }
}

// Scanning every nested string preserves legacy behavior but can inspect non-class arguments.
export function classNameStaticsDeep(value: unknown): ClassStatic[] {
  const statics: ClassStatic[] = [];
  walk(value, (node) => {
    if (node.type === "Literal" && typeof node.value === "string") {
      statics.push({ text: node.value, node });
    } else if (node.type === "TemplateElement") {
      statics.push({ text: node.value.cooked ?? node.value.raw ?? "", node });
    }
  });
  return statics;
}

export function styleObjectProps(attrValue: Node | null | undefined): StyleProp[] {
  const objectExpression = objectExpressionOf(attrValue);
  if (!objectExpression) return [];
  const props: StyleProp[] = [];
  for (const property of objectExpression.properties) {
    if (property.type !== "Property") continue;
    const keyName = propKeyName(property);
    if (keyName == null) continue;
    props.push({ keyName, valueNode: property.value, node: property });
  }
  return props;
}

function objectExpressionOf(attrValue: Node | null | undefined): ObjectExpression | null {
  if (!attrValue || attrValue.type !== "JSXExpressionContainer") return null;
  let expression: Node = attrValue.expression;
  while (
    expression &&
    (expression.type === "TSAsExpression" ||
      expression.type === "TSSatisfiesExpression" ||
      expression.type === "ParenthesizedExpression")
  ) {
    expression = expression.expression;
  }
  return expression && expression.type === "ObjectExpression" ? expression : null;
}

function propKeyName(property: ObjectProperty): string | null {
  const key = property.key;
  if (!key) return null;
  if (property.computed && key.type !== "Literal") return null;
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal") return typeof key.value === "string" ? key.value : null;
  return null;
}
