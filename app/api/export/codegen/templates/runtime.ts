import type { IRSurface } from "@contracts/design-ir";

/**
 * UI 库运行时模板(M5-2,文档 §2.1-2)
 *
 * 在语义映射静态版之上,为 shadcn/antd 生成"真实组件 import + 映射渲染器":
 * 页面 TSX 改为 import 模板提供的组件包装层,未映射类型退化静态 div 保持视觉接近。
 * 模板选择由 exports 路由的 adapterId 决定(shadcn-tailwind 保持现状零回归)。
 */

export interface MappedComponent {
  /** JSX 组件名(可含成员表达式,如 Input.TextArea) */
  comp: string;
  /** import 名(默认取 comp 第一段);复用静态 div 时留空则不产生 import */
  importName?: string;
  /** 组件 props(值直接进入 JSX 属性) */
  props?: Record<string, unknown>;
  /** 附加 className(布局包装) */
  className?: string;
  /** 自闭合组件(无 children) */
  selfClose?: boolean;
}

export interface RuntimeTemplate {
  id: string;
  /** 追加到生成工程 package.json 的运行时依赖 */
  extraDependencies?: Record<string, string>;
  /** 模板注入文件(组件包装层等),相对工程根 */
  templateFiles: { path: string; content: string }[];
  /** import 语句来源(如 "antd" / "./ui/kit") */
  importSource: string;
  /** Catalog type → 组件映射;undefined 时调用方退化静态映射 */
  mapComponent(type: string, props: Record<string, unknown>): MappedComponent | undefined;
}

/** 静态兜底形状(由 codegen 的 MAP 提供) */
export interface StaticFallback {
  comp: string; // HTML 标签
  className: string;
  extra?: Record<string, unknown>;
  selfClose?: boolean;
}

function escapeJsxText(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;");
}

function escapeAttr(v: unknown): string {
  return escapeJsxText(v);
}

function jsxProp(k: string, v: unknown): string {
  if (typeof v === "number" || typeof v === "boolean") return `${k}={${v}}`;
  if (typeof v === "string") return `${k}="${escapeAttr(v)}"`;
  return `${k}={${JSON.stringify(v)}}`;
}

function textOf(props: Record<string, unknown>): string {
  for (const k of ["text", "label", "title", "value", "name"]) {
    if (typeof props[k] === "string") return props[k] as string;
  }
  return "";
}

/**
 * 按运行时模板把 surface 转成页面 TSX body;同时返回该页用到的组件 import 名集合。
 * 映射顺序:模板组件 → 静态兜底(html 标签)→ data-unknown 退化。
 */
export function surfaceToTsxRuntime(
  surface: IRSurface,
  tpl: RuntimeTemplate,
  staticFallback: (type: string, props: Record<string, unknown>) => StaticFallback | undefined,
  unmapped: { surfaceId: string; type: string }[],
): { body: string; componentNames: string[] } {
  const lines: string[] = [];
  const used = new Set<string>();

  const emit = (id: string, depth: number): void => {
    const node = surface.components[id];
    if (!node) return;
    const pad = "  ".repeat(depth + 2);
    const props = (node.props ?? {}) as Record<string, unknown>;
    const mapped = tpl.mapComponent(node.type, props);

    if (mapped) {
      if (mapped.importName) used.add(mapped.importName);
      const attrParts: string[] = [];
      for (const [k, v] of Object.entries(mapped.props ?? {})) {
        if (v === undefined || v === null || v === "") continue;
        attrParts.push(jsxProp(k, v));
      }
      if (mapped.className) attrParts.push(`className="${escapeAttr(mapped.className)}"`);
      const attrs = attrParts.join(" ");
      const open = `<${mapped.comp}${attrs ? ` ${attrs}` : ""}`;
      if (mapped.selfClose) {
        lines.push(`${pad}${open} />`);
        node.children.forEach((c) => emit(c, depth)); // 自闭合组件的子节点独立输出
        return;
      }
      const text = escapeJsxText(textOf(props));
      if (node.children.length === 0) {
        lines.push(`${pad}${open}>${text}</${mapped.comp}>`);
      } else {
        lines.push(`${pad}${open}>`);
        if (text) lines.push(`${pad}  ${text}`);
        node.children.forEach((c) => emit(c, depth + 1));
        lines.push(`${pad}</${mapped.comp}>`);
      }
      return;
    }

    // 静态兜底(视觉接近画布)
    const fb = staticFallback(node.type, props);
    if (fb) {
      const attrParts = [`className="${escapeAttr(fb.className)}"`];
      for (const [k, v] of Object.entries(fb.extra ?? {})) {
        if (v === undefined || v === null || v === "") continue;
        attrParts.push(`${k}="${escapeAttr(v)}"`);
      }
      const open = `<${fb.comp} ${attrParts.join(" ")}`;
      if (fb.selfClose) {
        lines.push(`${pad}${open} />`);
        node.children.forEach((c) => emit(c, depth));
        return;
      }
      const text = escapeJsxText(textOf(props));
      if (node.children.length === 0) {
        lines.push(`${pad}${open}>${text}</${fb.comp}>`);
      } else {
        lines.push(`${pad}${open}>`);
        if (text) lines.push(`${pad}  ${text}`);
        node.children.forEach((c) => emit(c, depth + 1));
        lines.push(`${pad}</${fb.comp}>`);
      }
      return;
    }

    unmapped.push({ surfaceId: surface.id, type: node.type });
    lines.push(`${pad}<div data-unknown="${escapeAttr(node.type)}">`);
    node.children.forEach((c) => emit(c, depth + 1));
    lines.push(`${pad}</div>`);
  };

  emit(surface.root, 0);
  return { body: lines.join("\n"), componentNames: [...used] };
}
