import ts from "typescript";
import { CATALOG_TYPES, type IRSurface } from "@contracts/design-ir";

/**
 * TSX Importer(M5.3):React TSX → Design IR 反向解析 + Import Report
 *
 * 解析用 TypeScript Compiler API(宿主依赖,零新增),映射策略:
 *  - HTML 标签 → Catalog 组件(语义近似:h1-h6→Title、p→Text、img→Image…)
 *  - 大写标签与 Catalog 同名则直接采用,否则记为 unmapped(降级 Col + data-unmapped 标记)
 *  - JSXText 子节点 → props.text;href/src/alt/placeholder/level 等常用属性透传
 *  - className 保留进 props(渲染器忽略,信息不丢失)
 *  - 表达式容器({expr})跳过并计数(导入静态快照语义)
 *
 * 退出标准:未映射项准确标记(unmapped 清单 + 逐文件映射计数)。
 */

const CATALOG = new Set<string>(CATALOG_TYPES);

/** 限制:防 DoS/失控文件 */
const MAX_FILES = 50;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_NODES = 5000;

/** HTML 标签 → Catalog 类型(语义近似映射) */
const TAG_MAP: Record<string, string> = {
  section: "Section",
  main: "Container",
  header: "Navbar",
  footer: "Footer",
  nav: "NavLinks",
  div: "Col",
  aside: "Col",
  h1: "Title",
  h2: "Title",
  h3: "Title",
  h4: "Title",
  h5: "Title",
  h6: "Title",
  p: "Text",
  span: "Text",
  strong: "Text",
  em: "Text",
  label: "Text",
  small: "Text",
  a: "Link",
  button: "Button",
  img: "Image",
  input: "Input",
  textarea: "Textarea",
  hr: "Divider",
  ul: "List",
  ol: "List",
  li: "ListItem",
  table: "Table",
  form: "Form",
  progress: "Progress",
};

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

export interface ImportReport {
  files: {
    name: string;
    surfaceId: string;
    nodeCount: number;
    /** 类型 → 节点数(映射成功的) */
    mapped: Record<string, number>;
  }[];
  /** 未映射标签/组件清单(准确标记) */
  unmapped: { file: string; tag: string; count: number }[];
  /** 被跳过的 JSX 表达式容器数量({expr} 导入为静态快照) */
  skippedExpressions: number;
  warnings: string[];
}

export interface ImportResult {
  surfaces: IRSurface[];
  report: ImportReport;
}

interface FileInput {
  name: string;
  content: string;
}

/** 入口:TSX 文件集 → surfaces + 报告 */
export function tsxFilesToSurfaces(files: FileInput[]): ImportResult {
  if (files.length > MAX_FILES) throw new Error(`文件数超限(≤${MAX_FILES})`);
  const report: ImportReport = { files: [], unmapped: [], skippedExpressions: 0, warnings: [] };
  const surfaces: IRSurface[] = [];
  let totalNodes = 0;
  const usedSurfaceIds = new Set<string>();

  files.forEach((f, idx) => {
    if (f.content.length > MAX_FILE_BYTES) throw new Error(`文件 ${f.name} 超过大小上限(512KB)`);
    const surfaceId = uniqueSurfaceId(f.name, usedSurfaceIds, idx);
    const unmappedCount = new Map<string, number>();
    const mappedCount = new Map<string, number>();
    const state = { nodeId: 0, skipped: 0, unmappedCount, mappedCount, file: f.name, report };

    const components: IRSurface["components"] = {};
    const source = ts.createSourceFile(f.name || `page${idx}.tsx`, f.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

    // 顶层:收集"最外层"JSX(JSX 在函数体内常见,故按无 JSX 祖先判定);多于一个时包一层 Section
    const topLevelJsx = collectOutermostJsx(source);
    if (topLevelJsx.length === 0) {
      report.warnings.push(`${f.name}: 未发现顶层 JSX,已跳过`);
      return;
    }

    const rootId = nextId(state);
    if (topLevelJsx.length === 1) {
      const { id } = convertNode(topLevelJsx[0], components, state);
      if (id == null) throw new Error(`${f.name}: 顶层节点解析失败`);
      surfaces.push(finalizeSurface(surfaceId, f.name, id, components));
    } else {
      components[rootId] = { type: "Section", props: {}, children: [] };
      for (const el of topLevelJsx) {
        const { id } = convertNode(el, components, state);
        if (id) components[rootId]!.children.push(id);
      }
      surfaces.push(finalizeSurface(surfaceId, f.name, rootId, components));
    }
    totalNodes += Object.keys(components).length;

    report.files.push({
      name: f.name,
      surfaceId,
      nodeCount: Object.keys(components).length,
      mapped: Object.fromEntries([...mappedCount.entries()].sort()),
    });
    for (const [tag, count] of unmappedCount) report.unmapped.push({ file: f.name, tag, count });
    report.skippedExpressions += state.skipped;
  });

  if (totalNodes > MAX_NODES) throw new Error(`节点总数超限(≤${MAX_NODES}),请拆分文件`);
  if (surfaces.length === 0) throw new Error("没有可导入的 JSX 内容");
  return { surfaces, report };
}

// ---------------------------------------------------------------------------
// 内部:JSX AST → IR 节点
// ---------------------------------------------------------------------------

interface ConvertState {
  nodeId: number;
  skipped: number;
  file: string;
  unmappedCount: Map<string, number>;
  mappedCount: Map<string, number>;
  report: ImportReport;
}

function nextId(state: ConvertState): string {
  state.nodeId += 1;
  return `n${state.nodeId}`;
}

/** 收集最外层 JSX 节点(返回表达式体内的 <section>… 而非其内部子元素) */
function collectOutermostJsx(source: ts.SourceFile): (ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment)[] {
  const found: (ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment)[] = [];
  let jsxDepth = 0;
  const visit = (node: ts.Node): void => {
    const isJsx = ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node);
    if (isJsx) {
      if (jsxDepth === 0) found.push(node);
      jsxDepth += 1;
      ts.forEachChild(node, visit);
      jsxDepth -= 1;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found;
}

function uniqueSurfaceId(name: string, used: Set<string>, idx: number): string {
  const base = (name.replace(/\.[jt]sx$/i, "").replace(/[^\w-]+/g, "_").toLowerCase() || `page${idx + 1}`).slice(0, 40);
  let id = `import_${base}`;
  let n = 2;
  while (used.has(id)) id = `import_${base}_${n++}`;
  used.add(id);
  return id;
}

function finalizeSurface(surfaceId: string, name: string, root: string, components: IRSurface["components"]): IRSurface {
  return {
    id: surfaceId,
    title: name.replace(/\.[jt]sx$/i, "").trim() || surfaceId,
    root,
    components,
  };
}

/** 递归转换;返回节点 id(纯文本/空表达式返回 null) */
function convertNode(
  node: ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment | ts.JsxText | ts.JsxExpression | ts.JsxSpreadAttribute,
  components: IRSurface["components"],
  state: ConvertState,
): { id: string | null } {
  if (ts.isJsxText(node)) return { id: null }; // 文本由父节点统一收集
  if (ts.isJsxExpression(node) || ts.isJsxSpreadAttribute(node)) {
    state.skipped += 1;
    return { id: null };
  }
  if (ts.isJsxFragment(node)) {
    // Fragment:把子节点提升为虚拟容器(Col),保持树形
    const id = nextId(state);
    components[id] = { type: "Col", props: {}, children: [] };
    convertJsxChildren(node.children, components[id]!.children, components, state);
    return { id };
  }

  const tagName = ts.isJsxElement(node)
    ? node.openingElement.tagName.getText()
    : node.tagName.getText();
  const attributes = ts.isJsxElement(node)
    ? node.openingElement.attributes
    : ts.isJsxSelfClosingElement(node)
      ? node.attributes
      : undefined;
  const props: Record<string, unknown> = {};
  if (attributes) {
    for (const attr of attributes.properties) {
      if (!ts.isJsxAttribute(attr)) {
        state.skipped += 1;
        continue;
      }
      const name = attr.name.getText();
      const value = attrValueOf(attr, state);
      if (value === undefined) continue;
      props[name] = value;
    }
  }

  // 文本子节点与元素子节点
  const childIds: string[] = [];
  let ownText = "";
  const children = "children" in node && Array.isArray(node.children) ? node.children : [];
  for (const child of children) {
    if (ts.isJsxText(child)) {
      ownText += child.getText();
      continue;
    }
    if (ts.isJsxExpression(child)) {
      state.skipped += 1;
      continue;
    }
    const { id } = convertNode(child, components, state);
    if (id) childIds.push(id);
  }
  const text = ownText.replace(/\s+/g, " ").trim();
  if (text && props.text == null) props.text = text;

  // 标签映射
  let type: string;
  if (CATALOG.has(tagName)) {
    type = tagName; // 大写且在 Catalog 中:直接采用
  } else if (TAG_MAP[tagName]) {
    type = TAG_MAP[tagName];
  } else {
    // 未映射:准确标记 + 降级为 Col 容器保留子树
    state.unmappedCount.set(tagName, (state.unmappedCount.get(tagName) ?? 0) + 1);
    type = "Col";
    props["data-unmapped"] = tagName;
  }
  state.mappedCount.set(type, (state.mappedCount.get(type) ?? 0) + 1);

  // 语义修正
  if (type === "Title" && HEADING_TAGS.has(tagName)) props.level = Number(tagName.slice(1));
  if (type === "Link" && props.href == null) props.href = "#";
  if (type === "Image" && props.src == null) props.src = "";
  if (type === "Input" && props.placeholder == null && typeof props.value === "string") props.placeholder = props.value;

  const id = nextId(state);
  components[id] = { type: type as IRSurface["components"][string]["type"], props, children: childIds };
  return { id };
}

function convertJsxChildren(
  children: readonly (ts.JsxChild)[],
  out: string[],
  components: IRSurface["components"],
  state: ConvertState,
): void {
  for (const child of children) {
    if (ts.isJsxText(child)) {
      const text = child.getText().replace(/\s+/g, " ").trim();
      if (text) {
        // Fragment 下的裸文本挂到提升容器自身:追加为 Text 节点
        const id = nextId(state);
        components[id] = { type: "Text", props: { text }, children: [] };
        out.push(id);
      }
      continue;
    }
    if (ts.isJsxExpression(child)) {
      state.skipped += 1;
      continue;
    }
    const { id } = convertNode(child, components, state);
    if (id) out.push(id);
  }
}

/** JSX 属性求值:字符串/数字/布尔字面量;表达式跳过返回 undefined */
function attrValueOf(attr: ts.JsxAttribute, state: ConvertState): unknown {
  const init = attr.initializer;
  if (!init) return true; // <Input required />
  if (ts.isStringLiteral(init)) return init.text;
  if (ts.isJsxExpression(init)) {
    const expr = init.expression;
    if (!expr) return true;
    if (ts.isStringLiteral(expr)) return expr.text;
    if (ts.isNumericLiteral(expr)) return Number(expr.text);
    if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
    state.skipped += 1;
    return undefined;
  }
  state.skipped += 1;
  return undefined;
}
