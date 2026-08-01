/**
 * IR → 目标代码序列化器:HTML / React JSX / Vue 模板
 */
import type { IRNode } from "./ir";

// 图标名 → 文本字形(无依赖,导出工程开箱即用)
const ICON_GLYPH: Record<string, string> = {
  activity: "◔", award: "✦", "arrow-right": "→", chart: "▥", bell: "◍", bookmark: "▣",
  check: "✓", "chevron-right": "›", clock: "◷", compass: "◎", download: "↓", eye: "◉",
  flame: "♨", gift: "✜", globe: "◐", grid: "▦", heart: "♥", home: "⌂", image: "▨",
  "line-chart": "◠", lock: "⚿", map: "▤", menu: "☰", message: "◱", moon: "☾",
  palette: "◒", play: "▶", plug: "⚡", plus: "+", "plus-circle": "⊕", rocket: "▲",
  search: "⌕", settings: "⚙", shield: "⛉", "shopping-cart": "◫", sparkles: "✦",
  star: "★", target: "◎", "trending-up": "↗", user: "◯", users: "◯◯", wallet: "▭", zap: "⚡",
};
const glyph = (name?: string) => ICON_GLYPH[name ?? "sparkles"] ?? "✦";

const escHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const escJs = (s: string) => s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");

// style object → css 字符串
function cssText(style?: Record<string, string | number>): string {
  if (!style) return "";
  return Object.entries(style)
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}:${typeof v === "number" ? `${v}px` : v}`)
    .join(";");
}

const VOID_TAGS = new Set(["input", "hr", "img", "br"]);

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------
export function irToHtml(node: IRNode, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (node.icon) {
    return `${pad}<span style="font-size:${node.iconSize ?? 16}px;line-height:1;${cssText(node.style)}">${glyph(node.icon)}</span>`;
  }
  const attrs = Object.entries(node.attrs ?? {}).map(([k, v]) => ` ${k}="${escHtml(v)}"`).join("");
  const style = cssText(node.style);
  const styleAttr = style ? ` style="${escHtml(style)}"` : "";
  if (VOID_TAGS.has(node.tag)) return `${pad}<${node.tag}${attrs}${styleAttr}/>`;
  if (node.html) return `${pad}<${node.tag}${attrs}${styleAttr}>${node.html}</${node.tag}>`;
  const children = node.children ?? [];
  if (!children.length && node.text != null) return `${pad}<${node.tag}${attrs}${styleAttr}>${escHtml(node.text)}</${node.tag}>`;
  const inner = [
    node.text != null ? `${"  ".repeat(indent + 1)}${escHtml(node.text)}` : "",
    ...children.map((c) => irToHtml(c, indent + 1)),
  ].filter(Boolean).join("\n");
  return `${pad}<${node.tag}${attrs}${styleAttr}>\n${inner}\n${pad}</${node.tag}>`;
}

/** 整页 HTML 文档 */
export function htmlDocument(title: string, bodyHtml: string, nav: { href: string; label: string; active: boolean }[]): string {
  const navHtml = nav.length > 1
    ? `<nav style="position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:99;display:flex;gap:4px;background:rgba(20,20,25,0.85);backdrop-filter:blur(8px);padding:6px;border-radius:999px;box-shadow:0 8px 30px rgba(0,0,0,0.25)">${nav
        .map((n) => `<a href="${escHtml(n.href)}" style="padding:6px 14px;border-radius:999px;font-size:12px;text-decoration:none;${n.active ? "background:#fff;color:#111;font-weight:600" : "color:rgba(255,255,255,0.75)"}">${escHtml(n.label)}</a>`)
        .join("")}</nav>`
    : "";
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${escHtml(title)}</title>
<style>*{margin:0;padding:0}body{-webkit-font-smoothing:antialiased}button{font-family:inherit}a{font-family:inherit}</style>
</head>
<body>
${bodyHtml}
${navHtml}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// React JSX
// ---------------------------------------------------------------------------
function jsxStyle(style?: Record<string, string | number>): string {
  if (!style || !Object.keys(style).length) return "";
  const inner = Object.entries(style)
    .map(([k, v]) => `${k}: ${typeof v === "number" ? v : `"${escJs(v)}"`}`)
    .join(", ");
  return ` style={{ ${inner} }}`;
}

export function irToJsx(node: IRNode, indent = 2): string {
  const pad = "  ".repeat(indent);
  if (node.icon) {
    return `${pad}<span style={{ fontSize: ${node.iconSize ?? 16}, lineHeight: 1${node.style ? `, ...${styleToObjLiteral(node.style)}` : ""} }}>${glyph(node.icon)}</span>`;
  }
  const attrs = Object.entries(node.attrs ?? {}).map(([k, v]) => {
    const name = k === "readonly" ? "readOnly" : k;
    return ` ${name}="${escHtml(v)}"`;
  }).join("");
  const style = jsxStyle(node.style);
  if (VOID_TAGS.has(node.tag)) return `${pad}<${node.tag}${attrs}${style} />`;
  if (node.html) return `${pad}<${node.tag}${attrs}${style} dangerouslySetInnerHTML={{ __html: \`${node.html.replace(/`/g, "\\`")}\` }} />`;
  const children = node.children ?? [];
  if (!children.length && node.text != null) return `${pad}<${node.tag}${attrs}${style}>{\`${escJs(node.text)}\`}</${node.tag}>`;
  const inner = [
    node.text != null ? `${"  ".repeat(indent + 1)}{\`${escJs(node.text)}\`}` : "",
    ...children.map((c) => irToJsx(c, indent + 1)),
  ].filter(Boolean).join("\n");
  return `${pad}<${node.tag}${attrs}${style}>\n${inner}\n${pad}</${node.tag}>`;
}

function styleToObjLiteral(style: Record<string, string | number>): string {
  return `{ ${Object.entries(style).map(([k, v]) => `${k}: ${typeof v === "number" ? v : `"${escJs(v)}"`}`).join(", ")} }`;
}

// ---------------------------------------------------------------------------
// Vue 模板(静态)
// ---------------------------------------------------------------------------
export function irToVueTemplate(node: IRNode, indent = 2): string {
  // Vue 模板可直接使用 HTML 序列化结果
  return irToHtml(node, indent);
}

/** 文件名安全化 */
export function slugify(title: string, index: number): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || `page-${index + 1}`;
}
