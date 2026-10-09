/**
 * 流式草稿容错解析器
 * LLM 逐 token 输出 JSON 期间,把"已完整闭合"的部分提取为可渲染的 SurfaceDoc 草稿:
 * - page / theme 只在完整闭合时采用,否则用默认值
 * - components 逐个条目做括号配平,只保留完整闭合且结构合法的组件
 * - root 缺失时回退到第一个组件 id;children 只保留已存在的引用
 */
import type { ComponentNode, DeviceId, PresetId, SurfaceDoc, ThemeTokens } from "@contracts/a2ui";
import { CATALOG_TYPES, DEFAULT_TOKENS, DEVICE_IDS } from "@contracts/a2ui";

const CATALOG_SET = new Set<string>(CATALOG_TYPES);

export interface PartialParseOptions {
  preset: PresetId;
  device: DeviceId;
}

/** 从 openIdx(必须是 '{' 或 '[')开始做字符串感知的括号配平,返回闭合位置(含)的下标 +1;未闭合返回 -1 */
function balancedEnd(text: string, openIdx: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** 定位顶层 key(如 "page")的值起始下标;找不到返回 -1 */
function valueStart(text: string, key: string): number {
  const m = new RegExp(`"${key}"\\s*:`).exec(text);
  if (!m) return -1;
  let i = m.index + m[0].length;
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

/** 提取某个 key 的完整 JSON 对象;未闭合或解析失败返回 null */
function extractObject(text: string, key: string): Record<string, unknown> | null {
  const start = valueStart(text, key);
  if (start < 0 || text[start] !== "{") return null;
  const end = balancedEnd(text, start);
  if (end < 0) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end)) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* 半行 JSON */ }
  return null;
}

function sanitizeNode(id: string, raw: unknown): ComponentNode | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.type !== "string" || !CATALOG_SET.has(o.type)) return null;
  const props = o.props && typeof o.props === "object" && !Array.isArray(o.props)
    ? (o.props as Record<string, unknown>)
    : {};
  const children = Array.isArray(o.children)
    ? o.children.filter((c): c is string => typeof c === "string" && c !== id)
    : [];
  return { type: o.type, props, children };
}

function parseTokens(raw: Record<string, unknown> | null): ThemeTokens {
  const tokens = raw?.tokens;
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return DEFAULT_TOKENS;
  const t = tokens as Record<string, unknown>;
  const hex = (v: unknown, fallback: string) =>
    typeof v === "string" && /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : fallback;
  return {
    primary: hex(t.primary, DEFAULT_TOKENS.primary),
    background: hex(t.background, DEFAULT_TOKENS.background),
    surface: hex(t.surface, DEFAULT_TOKENS.surface),
    text: hex(t.text, DEFAULT_TOKENS.text),
    mutedText: hex(t.mutedText, DEFAULT_TOKENS.mutedText),
    accent: hex(t.accent, DEFAULT_TOKENS.accent),
    radius: typeof t.radius === "number" && t.radius >= 0 && t.radius <= 40 ? t.radius : DEFAULT_TOKENS.radius,
    font: typeof t.font === "string" ? t.font.slice(0, 120) : DEFAULT_TOKENS.font,
  };
}

/**
 * 把 LLM 输出到一半的文本解析成可渲染草稿。
 * 返回 null 表示还没有任何可渲染内容(components 一个都没闭合)。
 */
export function parsePartialSurface(raw: string, opts: PartialParseOptions): SurfaceDoc | null {
  const cleaned = raw.replace(/```json|```/g, "");
  const brace = cleaned.indexOf("{");
  if (brace < 0) return null;
  const text = cleaned.slice(brace);

  // ---- page(完整闭合才采用) ----
  const pageRaw = extractObject(text, "page");
  const deviceRaw = pageRaw?.device;
  const page = {
    id: typeof pageRaw?.id === "string" && pageRaw.id ? pageRaw.id.slice(0, 40) : "draft",
    title: typeof pageRaw?.title === "string" && pageRaw.title ? pageRaw.title.slice(0, 60) : "生成中…",
    device: (DEVICE_IDS as string[]).includes(deviceRaw as string) ? (deviceRaw as DeviceId) : opts.device,
  };

  // ---- theme(完整闭合才采用,tokens 逐字段校验) ----
  const themeRaw = extractObject(text, "theme");
  const theme = { preset: opts.preset, tokens: parseTokens(themeRaw) };

  // ---- components:逐个条目配平,只保留完整闭合的 ----
  const compStart = valueStart(text, "components");
  if (compStart < 0 || text[compStart] !== "{") return null;
  const components: Record<string, ComponentNode> = {};
  let i = compStart + 1;
  const scan = (): void => {
    while (i < text.length) {
      // 跳过空白与逗号
      while (i < text.length && /[\s,]/.test(text[i])) i++;
      if (i >= text.length || text[i] === "}") return;
      if (text[i] !== '"') return; // 非 key 起始,停止
      // 解析 key 字符串
      const keyEnd = balancedEndString(text, i);
      if (keyEnd < 0) return; // key 未闭合
      const key = text.slice(i + 1, keyEnd - 1);
      i = keyEnd;
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text[i] !== ":") return;
      i++;
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text[i] !== "{") return; // 值不是对象(异常),停止
      const end = balancedEnd(text, i);
      if (end < 0) return; // 该组件未闭合 → 之后的都不可用
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text.slice(i, end));
      } catch { /* 半行 JSON,跳过 */ }
      const node = sanitizeNode(key, parsed);
      if (node) components[key] = node;
      i = end;
    }
  };
  scan();

  const ids = Object.keys(components);
  if (!ids.length) return null;

  // ---- root:完整 "root": "xxx" 才采用,否则第一个组件 ----
  const rootMatch = /"root"\s*:\s*"([^"]+)"/.exec(text);
  const root = rootMatch && components[rootMatch[1]] ? rootMatch[1] : ids[0];

  // children 只保留已存在的引用,避免渲染器空转
  for (const node of Object.values(components)) {
    node.children = node.children.filter((c) => components[c]);
  }

  return { version: "1.0", page, theme, components, root };
}

/**
 * 多页草稿解析:{pages:[...]} 输出流式到达时逐页容错解析:
 * - 已闭合的页面对象 → 完整解析
 * - 正在生成的最后一页(未闭合) → 截断容错解析(可能为 null,表示还没有可渲染组件)
 * 单页输出退化为单元素数组;解析不出任何页面返回空数组
 */
export function parsePartialPages(raw: string, opts: PartialParseOptions): (SurfaceDoc | null)[] {
  const cleaned = raw.replace(/```json|```/g, "");
  const brace = cleaned.indexOf("{");
  if (brace < 0) return [];
  const text = cleaned.slice(brace);

  // 多页结构:{ "pages": [ {...}, {...} ... ] }(version 字段可能在 pages 之前)
  if (!/^\{\s*(?:"version"\s*:\s*"[^"]*"\s*,\s*)?"pages"\s*:\s*\[/.test(text)) {
    const doc = parsePartialSurface(raw, opts);
    return doc ? [doc] : [];
  }

  const arrStart = valueStart(text, "pages");
  if (arrStart < 0 || text[arrStart] !== "[") return [];
  const docs: (SurfaceDoc | null)[] = [];
  let i = arrStart + 1;
  while (i < text.length) {
    // 跳过空白与逗号
    while (i < text.length && /[\s,]/.test(text[i])) i++;
    if (i >= text.length || text[i] === "]") break;
    if (text[i] !== "{") break; // 结构异常,停止
    const end = balancedEnd(text, i);
    if (end >= 0) {
      docs.push(parsePartialSurface(text.slice(i, end), opts));
      i = end;
    } else {
      // 正在生成的最后一页:截断容错
      docs.push(parsePartialSurface(text.slice(i), opts));
      break;
    }
  }
  return docs;
}

/** 字符串字面量(含转义)的配平:返回闭合引号后一位;未闭合返回 -1 */
function balancedEndString(text: string, openQuote: number): number {
  let escaped = false;
  for (let i = openQuote + 1; i < text.length; i++) {
    const ch = text[i];
    if (escaped) escaped = false;
    else if (ch === "\\") escaped = true;
    else if (ch === '"') return i + 1;
  }
  return -1;
}

/**
 * ops 流式草稿解析(edit/局部修改路径):{"ops":[{...},{...}]} 逐 token 到达时,
 * 逐元素做括号配平,只返回已完整闭合且可 JSON.parse 的原始 op 对象(宽松,不过 schema ——
 * 仅供预览;提交前的最终校验仍由 kimiGenerateOps 的 zod + applyOps 二次验证负责)
 */
export function parsePartialOps(raw: string): Record<string, unknown>[] {
  const cleaned = raw.replace(/```json|```/g, "");
  const brace = cleaned.indexOf("{");
  if (brace < 0) return [];
  const text = cleaned.slice(brace);
  const arrStart = valueStart(text, "ops");
  if (arrStart < 0 || text[arrStart] !== "[") return [];
  const ops: Record<string, unknown>[] = [];
  let i = arrStart + 1;
  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i])) i++;
    if (i >= text.length || text[i] === "]") break;
    if (text[i] !== "{") break; // 结构异常,停止
    const end = balancedEnd(text, i);
    if (end < 0) break; // 最后一个元素未闭合
    try {
      const parsed = JSON.parse(text.slice(i, end)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        ops.push(parsed as Record<string, unknown>);
      }
    } catch { /* 半行 JSON */ }
    i = end;
  }
  return ops;
}

/**
 * 流式预览增量合并(前端):把后端 delta 帧(upserts = 新增/变化的组件)合并进
 * 累积文档。注意:不在此过滤悬空 children —— 流式期间引用可能先于目标组件到达,
 * 提前过滤会永久丢失引用;渲染端对缺失节点已容错(返回 null),后续帧到达后引用自然生效。
 * meta 提供 root/标题/设备/主题,缺省沿用 base。
 */
export function mergePreviewDelta(
  base: SurfaceDoc | null,
  upserts: Record<string, Record<string, unknown>> | undefined,
  meta: { root?: string; title?: string; device?: string; theme?: SurfaceDoc["theme"] } | undefined,
): SurfaceDoc {
  const components: Record<string, SurfaceDoc["components"][string]> = { ...(base?.components ?? {}) };
  for (const [aid, node] of Object.entries(upserts ?? {})) {
    if (node && typeof node === "object") {
      components[aid] = {
        type: String((node as { type?: unknown }).type ?? "Col"),
        props: ((node as { props?: Record<string, unknown> }).props ?? {}) as Record<string, unknown>,
        children: Array.isArray((node as { children?: unknown }).children)
          ? ((node as { children: string[] }).children).filter((c) => typeof c === "string")
          : [],
      };
    }
  }
  const root = meta?.root && components[meta.root] ? meta.root : base?.root ?? Object.keys(components)[0] ?? "root";
  return {
    version: "1.0",
    page: {
      id: base?.page.id ?? root,
      title: meta?.title ?? base?.page.title ?? "生成中…",
      device: (meta?.device as DeviceId) ?? base?.page.device ?? "desktop",
    },
    theme: meta?.theme ?? base?.theme ?? { preset: "shadcn", tokens: DEFAULT_TOKENS },
    components,
    root,
  };
}
