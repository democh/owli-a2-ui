/**
 * A2UI SurfaceDoc → IR(中间表示)
 * 与渲染器解耦的静态节点树,可被序列化为 HTML / React JSX / Vue 模板
 */
import type { ComponentNode, SurfaceDoc, ThemeTokens } from "@contracts/a2ui";

export interface IRNode {
  tag: string;
  style?: Record<string, string | number>;
  attrs?: Record<string, string>;
  text?: string;
  /** 原始 HTML(图表 SVG 等) */
  html?: string;
  children?: IRNode[];
  /** 图标名(序列化器决定字形) */
  icon?: string;
  iconSize?: number;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : v == null ? d : String(v));
const num = (v: unknown, d = 0): number => (typeof v === "number" ? v : Number(v) || d);
const bool = (v: unknown, d = false): boolean => (typeof v === "boolean" ? v : d);
const arr = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

function seeded(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
const GRADIENTS = [
  "linear-gradient(135deg,#667eea,#764ba2)",
  "linear-gradient(135deg,#f093fb,#f5576c)",
  "linear-gradient(135deg,#4facfe,#00f2fe)",
  "linear-gradient(135deg,#43e97b,#38f9d7)",
  "linear-gradient(135deg,#fa709a,#fee140)",
  "linear-gradient(135deg,#30cfd0,#330867)",
  "linear-gradient(135deg,#a8edea,#fed6e3)",
  "linear-gradient(135deg,#ff9a9e,#fecfef)",
];
const gradientFor = (seed: string) => GRADIENTS[seeded(seed) % GRADIENTS.length];

interface Ctx {
  doc: SurfaceDoc;
  t: ThemeTokens;
  render: (id: string) => IRNode | null;
  /** 多页站点导出时:按链接文案解析对应页面的路径(命中则重写导航 href) */
  link?: (label: string) => string | undefined;
}

const icon = (name: unknown, size = 16, style: Record<string, string | number> = {}): IRNode => ({
  tag: "i", icon: str(name, "sparkles"), iconSize: size, style: { display: "inline-flex", flexShrink: 0, ...style },
});

const cardStyle = (t: ThemeTokens): Record<string, string | number> => ({
  background: "#fff",
  borderRadius: t.radius,
  border: "1px solid rgba(0,0,0,0.06)",
  boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
});

const buttonStyle = (t: ThemeTokens, variant: string): Record<string, string | number> => {
  const base: Record<string, string | number> = {
    display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 500,
    borderRadius: t.radius, padding: "8px 16px", fontSize: 14, cursor: "pointer",
    border: "none", width: "fit-content",
  };
  if (variant === "outline") return { ...base, border: "1px solid rgba(0,0,0,0.12)", background: "#fff", color: t.text };
  if (variant === "ghost") return { ...base, color: t.text, background: "transparent" };
  if (variant === "danger") return { ...base, background: "#dc2626", color: "#fff" };
  if (variant === "success") return { ...base, background: "#16a34a", color: "#fff" };
  return { ...base, background: t.primary, color: "#fff", boxShadow: "0 1px 2px rgba(0,0,0,0.08)" };
};

const inputStyle = (t: ThemeTokens): Record<string, string | number> => ({
  width: "100%", padding: "10px 14px", fontSize: 14, borderRadius: t.radius,
  border: "1px solid rgba(0,0,0,0.1)", background: "#fff", color: t.text,
  boxSizing: "border-box", outline: "none",
});

// ---------------------------------------------------------------------------
// 各类组件 → IR
// ---------------------------------------------------------------------------
function nodeToIR(id: string, ctx: Ctx): IRNode | null {
  const { t } = ctx;
  const n = ctx.doc.components[id];
  if (!n) return null;
  const p = n.props;
  const kids = () => n.children.map((c) => ctx.render(c)).filter(Boolean) as IRNode[];

  switch (n.type) {
    // ---------- 布局 ----------
    case "Navbar": {
      const links = arr<string>(p.links);
      return {
        tag: "header",
        style: {
          position: "sticky", top: 0, zIndex: 20, display: "flex", alignItems: "center",
          justifyContent: "space-between", padding: "14px 28px",
          background: "rgba(255,255,255,0.9)", backdropFilter: "blur(8px)",
          borderBottom: "1px solid rgba(0,0,0,0.06)",
        },
        children: [
          { tag: "div", style: { display: "flex", alignItems: "center", gap: 10 }, children: [
            { tag: "span", text: str(p.logo, "N").slice(0, 1), style: {
              width: 30, height: 30, borderRadius: t.radius, background: t.primary, color: "#fff",
              display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 14 } },
            { tag: "strong", text: str(p.logo, "Nova"), style: { fontSize: 17, color: t.text } },
          ] },
          { tag: "nav", style: { display: "flex", gap: 26 }, children: links.map((l): IRNode => ({
            tag: "a", text: l, attrs: { href: ctx.link?.(l) ?? "#" }, style: { fontSize: 14, color: t.mutedText, textDecoration: "none", cursor: "pointer" } })) },
          ...(p.cta ? [{ tag: "button", text: str(p.cta), style: { ...buttonStyle(t, "primary"), padding: "7px 14px", fontSize: 13 } }] : []),
        ],
      };
    }
    case "Hero": {
      const compact = bool(p.compact);
      return {
        tag: "section",
        style: { textAlign: "center", padding: compact ? "52px 24px" : "104px 24px", position: "relative", overflow: "hidden" },
        children: [
          ...(p.badge ? [{ tag: "span", text: str(p.badge), style: {
            display: "inline-block", padding: "5px 14px", fontSize: 12, fontWeight: 500,
            borderRadius: 999, border: "1px solid rgba(0,0,0,0.1)", background: "rgba(255,255,255,0.75)",
            color: t.text, marginBottom: 22 } }] : []),
          { tag: "h1", text: str(p.title), style: {
            fontSize: compact ? 34 : 52, fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.14,
            color: t.text, maxWidth: 820, margin: "0 auto", whiteSpace: "pre-line" } },
          ...(p.subtitle ? [{ tag: "p", text: str(p.subtitle), style: {
            fontSize: 17, color: t.mutedText, maxWidth: 640, margin: "20px auto 0", lineHeight: 1.65 } }] : []),
          { tag: "div", style: { display: "flex", gap: 12, justifyContent: "center", marginTop: 34 }, children: [
            ...(p.primaryCta ? [{ tag: "button", text: str(p.primaryCta), style: { ...buttonStyle(t, "primary"), padding: "12px 24px", fontSize: 15 } }] : []),
            ...(p.secondaryCta ? [{ tag: "button", text: str(p.secondaryCta), style: { ...buttonStyle(t, "outline"), padding: "12px 24px", fontSize: 15 } }] : []),
          ] },
        ],
      };
    }
    case "Section":
      return { tag: "section", style: {
        display: "flex", flexDirection: "column", width: "100%", boxSizing: "border-box",
        gap: num(p.gap, 24), padding: num(p.padding, 24),
        ...(bool(p.center) ? { alignItems: "center", justifyContent: "center" } : {}),
        ...(p.minHeight ? { minHeight: "100vh" } : {}),
      }, children: kids() };
    case "Container":
      return { tag: "div", style: { maxWidth: 1120, margin: "0 auto", width: "100%", padding: num(p.padding, 0), boxSizing: "border-box" }, children: kids() };
    case "Row": {
      const ratios = arr<number>(p.ratios);
      return { tag: "div", style: {
        display: "flex", flexWrap: "wrap", width: "100%", gap: num(p.gap, 12),
        alignItems: str(p.align, "flex-start"), justifyContent: str(p.justify, "flex-start"), padding: num(p.padding, 0),
      }, children: n.children.map((c, i): IRNode => ({
        tag: "div",
        style: (ratios[i] ? { flex: ratios[i], minWidth: 0 } : { display: "contents" }) as Record<string, string | number>,
        children: [ctx.render(c)].filter(Boolean) as IRNode[],
      })) };
    }
    case "Col":
      return { tag: "div", style: { display: "flex", flexDirection: "column", alignItems: str(p.align, "stretch"), gap: num(p.gap, 8) }, children: kids() };
    case "Grid":
      return { tag: "div", style: {
        display: "grid", width: "100%", gridTemplateColumns: `repeat(${num(p.columns, 3)}, minmax(0,1fr))`,
        gap: num(p.gap, 16), padding: num(p.padding, 0), boxSizing: "border-box",
      }, children: kids() };
    case "Card":
      return { tag: "div", style: { ...cardStyle(t), padding: num(p.padding, 20) }, children: [
        ...(p.title ? [{ tag: "div", text: str(p.title), style: { fontWeight: 600, fontSize: 15, color: t.text, marginBottom: 12 } }] : []),
        { tag: "div", style: { display: "flex", flexDirection: "column", gap: 12 }, children: kids() },
      ] };
    case "Footer": {
      const groups = arr<{ title: string; links: string[] }>(p.groups);
      return { tag: "footer", style: {
        borderTop: "1px solid rgba(0,0,0,0.06)", background: "#fff", marginTop: 32,
        padding: "44px 32px", display: "flex", flexWrap: "wrap", gap: 40, justifyContent: "space-between" },
        children: [
          { tag: "div", style: { display: "flex", flexDirection: "column", gap: 8 }, children: [
            { tag: "strong", text: str(p.logo, "Nova"), style: { fontSize: 17, color: t.text } },
            ...(p.copyright ? [{ tag: "span", text: str(p.copyright), style: { fontSize: 12, color: t.mutedText } }] : []),
          ] },
          { tag: "div", style: { display: "flex", gap: 64 }, children: groups.map((g): IRNode => ({
            tag: "div", style: { display: "flex", flexDirection: "column", gap: 10 }, children: [
              { tag: "span", text: g.title, style: { fontSize: 14, fontWeight: 600, color: t.text } },
              ...(g.links ?? []).map((l): IRNode => ({ tag: "a", text: l, attrs: { href: ctx.link?.(l) ?? "#" }, style: { fontSize: 14, color: t.mutedText, textDecoration: "none" } })),
            ] })) },
        ] };
    }
    case "Divider":
      return { tag: "hr", style: { border: "none", borderTop: "1px solid rgba(0,0,0,0.07)", width: "100%", margin: 0 } };
    case "Tabs":
      return { tag: "div", style: { display: "flex", gap: 4, borderBottom: "1px solid rgba(0,0,0,0.08)" },
        children: arr<string>(p.tabs).map((tb, i): IRNode => ({
          tag: "button", text: tb, style: {
            padding: "10px 16px", fontSize: 14, background: "none", border: "none", cursor: "pointer",
            borderBottom: i === 0 ? `2px solid ${t.primary}` : "2px solid transparent",
            color: i === 0 ? t.text : t.mutedText, fontWeight: i === 0 ? 500 : 400, marginBottom: -1 } })) };
    case "SidebarLayout": {
      const menu = arr<string>(p.menu);
      const active = str(p.activeMenu);
      return { tag: "div", style: { display: "flex", minHeight: "100vh" }, children: [
        { tag: "aside", style: { width: 220, flexShrink: 0, background: "#fff", borderRight: "1px solid rgba(0,0,0,0.06)", display: "flex", flexDirection: "column" }, children: [
          { tag: "div", style: { height: 64, display: "flex", alignItems: "center", gap: 8, padding: "0 20px", borderBottom: "1px solid rgba(0,0,0,0.06)" }, children: [
            { tag: "span", text: str(p.logo, "N").slice(0, 1), style: {
              width: 28, height: 28, borderRadius: t.radius, background: t.primary, color: "#fff",
              display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 13 } },
            { tag: "strong", text: str(p.logo, "Nova"), style: { color: t.text } },
          ] },
          { tag: "nav", style: { flex: 1, padding: 12, display: "flex", flexDirection: "column", gap: 4 }, children: menu.map((m): IRNode => ({
            tag: "a", text: m, attrs: { href: ctx.link?.(m) ?? "#" }, style: {
              padding: "8px 12px", fontSize: 14, borderRadius: t.radius, cursor: "pointer", textDecoration: "none",
              ...(m === active ? { background: t.primary, color: "#fff", fontWeight: 500 } : { color: t.mutedText }) } })) },
        ] },
        { tag: "main", style: { flex: 1, minWidth: 0, background: t.background }, children: [
          { tag: "div", style: { height: 64, background: "#fff", borderBottom: "1px solid rgba(0,0,0,0.06)", display: "flex", alignItems: "center", padding: "0 24px" }, children: [
            { tag: "h1", text: str(p.title), style: { fontSize: 18, fontWeight: 600, color: t.text, margin: 0 } } ] },
          ...kids(),
        ] },
      ] };
    }

    // ---------- 排版 ----------
    case "Title": {
      const level = num(p.level, 2);
      const styles: Record<number, Record<string, string | number>> = {
        1: { fontSize: 36, fontWeight: 800, letterSpacing: "-0.02em" },
        2: { fontSize: 24, fontWeight: 700, letterSpacing: "-0.01em" },
        3: { fontSize: 20, fontWeight: 600 },
        4: { fontSize: 16, fontWeight: 600 },
      };
      return { tag: `h${Math.min(4, level)}`, text: str(p.text), style: { ...(styles[level] ?? styles[2]), color: t.text, margin: 0, whiteSpace: "pre-line" } };
    }
    case "Text": {
      const variant = str(p.variant);
      const style: Record<string, string | number> =
        variant === "lead" ? { fontSize: 18, color: t.mutedText }
        : variant === "muted" ? { fontSize: 14, color: t.mutedText }
        : variant === "caption" ? { fontSize: 12, color: t.mutedText }
        : { fontSize: 14, color: t.text, lineHeight: 1.7 };
      if (str(p.weight) === "medium") style.fontWeight = 500;
      return { tag: "p", text: str(p.text), style: { margin: 0, whiteSpace: "pre-line", ...style } };
    }
    case "Link":
      return { tag: "a", attrs: { href: ctx.link?.(str(p.label, str(p.text))) ?? str(p.href, "#") }, style: {
        fontSize: 14, fontWeight: 500, color: t.accent, textDecoration: "none", cursor: "pointer",
        display: "inline-flex", alignItems: "center", gap: 4 },
        children: [{ tag: "span", text: str(p.label, str(p.text, "链接")) }, icon("arrow-right", 14)] };
    case "Badge":
      return { tag: "span", text: str(p.label), style: {
        display: "inline-flex", width: "fit-content", padding: "3px 10px", fontSize: 12, fontWeight: 500,
        borderRadius: t.radius, background: t.surface, color: t.text } };
    case "Tag":
      return { tag: "span", text: str(p.label), style: {
        display: "inline-flex", width: "fit-content", padding: "3px 10px", fontSize: 12, fontWeight: 500,
        borderRadius: 999, background: `color-mix(in srgb, ${t.accent} 12%, transparent)`, color: t.accent } };

    // ---------- 表单 ----------
    case "Button":
      return { tag: "button", style: buttonStyle(t, str(p.variant, "primary")), children: [
        ...(p.icon ? [icon(p.icon, 15)] : []),
        { tag: "span", text: str(p.label, "按钮") },
      ] };
    case "Input":
      return { tag: "input", attrs: { placeholder: str(p.placeholder, "请输入…"), value: str(p.value), readonly: "true" }, style: inputStyle(t) };
    case "Textarea":
      return { tag: "textarea", attrs: { placeholder: str(p.placeholder, "请输入…"), readonly: "true" }, text: str(p.value), style: { ...inputStyle(t), minHeight: 90, resize: "vertical" } };
    case "Select":
      return { tag: "select", style: inputStyle(t), children: arr<string>(p.options).map((o): IRNode => ({ tag: "option", text: o })) };
    case "Checkbox": {
      const checked = bool(p.checked, true);
      return { tag: "label", style: { display: "inline-flex", alignItems: "center", gap: 8, fontSize: 14, color: t.text, cursor: "pointer", width: "fit-content" }, children: [
        { tag: "span", style: {
          width: 16, height: 16, borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center",
          ...(checked ? { background: t.primary, border: `1px solid ${t.primary}` } : { border: "1px solid rgba(0,0,0,0.2)", background: "#fff" }) },
          children: checked ? [{ tag: "span", text: "✓", style: { color: "#fff", fontSize: 11, lineHeight: 1 } }] : [] },
        { tag: "span", text: str(p.label) },
      ] };
    }
    case "Switch": {
      const on = bool(p.on, true);
      return { tag: "span", style: {
        position: "relative", display: "inline-flex", width: 40, height: 22, borderRadius: 999,
        background: on ? t.primary : "rgba(0,0,0,0.15)", cursor: "pointer", flexShrink: 0 }, children: [
        { tag: "span", style: {
          position: "absolute", top: 3, left: on ? 21 : 3, width: 16, height: 16,
          borderRadius: 999, background: "#fff", boxShadow: "0 1px 2px rgba(0,0,0,0.2)" } },
      ] };
    }
    case "SearchBar":
      return { tag: "div", style: {
        display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderRadius: t.radius,
        border: "1px solid rgba(0,0,0,0.1)", background: "#fff", width: num(p.width) || "100%", boxSizing: "border-box" }, children: [
        icon("search", 16, { color: t.mutedText }),
        { tag: "input", attrs: { placeholder: str(p.placeholder, "搜索…"), readonly: "true" }, style: {
          flex: 1, fontSize: 14, border: "none", outline: "none", background: "transparent", color: t.text, minWidth: 0 } },
      ] };
    case "Form": {
      const fields = arr<{ label: string; type: string; value?: string; options?: string[] }>(p.fields);
      return { tag: "div", style: { display: "flex", flexDirection: "column", gap: 16 }, children: [
        ...fields.map((f): IRNode => ({ tag: "div", style: { display: "flex", flexDirection: "column", gap: 6 }, children: [
          { tag: "label", text: f.label, style: { fontSize: 14, fontWeight: 500, color: t.text } },
          (f.type === "textarea"
            ? { tag: "textarea", attrs: { readonly: "true" }, text: f.value ?? "", style: { ...inputStyle(t), minHeight: 90 } }
            : f.type === "select"
              ? { tag: "select", style: inputStyle(t), children: (f.options ?? []).map((o): IRNode => ({ tag: "option", text: o })) }
              : { tag: "input", attrs: { value: f.value ?? "", readonly: "true" }, style: inputStyle(t) }) as IRNode,
        ] })),
        ...(p.submitLabel ? [{ tag: "button", text: str(p.submitLabel), style: buttonStyle(t, "primary") } as IRNode] : []),
      ] };
    }
    case "LoginForm": {
      const isLogin = str(p.mode, "login") === "login";
      return { tag: "div", style: {
        minHeight: "100vh", width: "100%", display: "flex", alignItems: "center", justifyContent: "center",
        padding: 24, boxSizing: "border-box",
        background: `linear-gradient(135deg, color-mix(in srgb, ${t.accent} 10%, ${t.background}), ${t.background})` }, children: [
        { tag: "div", style: { ...cardStyle(t), width: "100%", maxWidth: 380, padding: 32, boxSizing: "border-box" }, children: [
          { tag: "div", style: {
            width: 44, height: 44, borderRadius: t.radius, background: t.primary, color: "#fff",
            display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 20 }, children: [icon("sparkles", 20)] },
          { tag: "h2", text: str(p.title, "欢迎"), style: { fontSize: 20, fontWeight: 700, color: t.text, margin: 0 } },
          { tag: "p", text: str(p.subtitle), style: { fontSize: 14, color: t.mutedText, margin: "6px 0 22px" } },
          { tag: "div", style: { display: "flex", flexDirection: "column", gap: 14 }, children: [
            ...(isLogin ? [] : [{ tag: "input", attrs: { placeholder: "昵称", readonly: "true" }, style: inputStyle(t) }]),
            { tag: "input", attrs: { placeholder: "邮箱", readonly: "true" }, style: inputStyle(t) },
            { tag: "input", attrs: { placeholder: "密码", type: "password", readonly: "true" }, style: inputStyle(t) },
            { tag: "button", text: str(p.submitLabel, "登 录"), style: { ...buttonStyle(t, "primary"), width: "100%", justifyContent: "center", marginTop: 4 } },
            { tag: "div", style: { display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12, color: t.mutedText }, children: [
              { tag: "span", text: "☑ 记住我" },
              { tag: "a", text: "忘记密码？", attrs: { href: "#" }, style: { color: t.mutedText, cursor: "pointer" } },
            ] },
          ] },
        ] },
      ] };
    }

    // ---------- 数据 ----------
    case "Table": {
      const columns = arr<{ key: string; title: string }>(p.columns);
      const rows = arr<unknown[]>(p.rows);
      const statusIdx = columns.findIndex((c) => c.key === str(p.statusKey));
      const avatarIdx = columns.findIndex((c) => c.key === str(p.avatarKey));
      const statusColor = (s: string): Record<string, string | number> =>
        /支付|在职|成功|active|完成/.test(s) ? { background: "#f0fdf4", color: "#15803d" }
        : /待|试用|pending/.test(s) ? { background: "#fffbeb", color: "#b45309" }
        : /退|休假|失败/.test(s) ? { background: "#fef2f2", color: "#dc2626" }
        : { background: "rgba(0,0,0,0.05)", color: t.mutedText };
      return { tag: "div", style: { width: "100%", overflowX: "auto" }, children: [
        { tag: "table", style: { width: "100%", fontSize: 14, borderCollapse: "collapse" }, children: [
          { tag: "thead", children: [{ tag: "tr", style: { borderBottom: "1px solid rgba(0,0,0,0.07)" }, children:
            columns.map((c): IRNode => ({ tag: "th", text: c.title, style: { textAlign: "left", fontWeight: 500, color: t.mutedText, padding: "10px 12px", whiteSpace: "nowrap" } })) }] },
          { tag: "tbody", children: rows.map((r): IRNode => ({ tag: "tr", style: { borderBottom: "1px solid rgba(0,0,0,0.04)" }, children:
            columns.map((_c, ci): IRNode => {
              const v = r[ci];
              if (ci === statusIdx) return { tag: "td", style: { padding: "12px", whiteSpace: "nowrap" }, children: [
                { tag: "span", text: String(v ?? ""), style: { padding: "2px 8px", borderRadius: 999, fontSize: 12, fontWeight: 500, ...statusColor(String(v)) } }] };
              if (ci === avatarIdx) return { tag: "td", style: { padding: "12px", whiteSpace: "nowrap" }, children: [
                { tag: "span", style: { display: "flex", alignItems: "center", gap: 10 }, children: [
                  { tag: "span", text: String(v ?? "").slice(0, 1), style: {
                    width: 28, height: 28, borderRadius: 999, display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 11, fontWeight: 600, color: "#fff", background: gradientFor(String(v)) } },
                  { tag: "span", text: String(v ?? ""), style: { color: t.text } },
                ] }] };
              return { tag: "td", text: String(v ?? ""), style: { padding: "12px", color: t.text, whiteSpace: "nowrap" } };
            }) })) },
        ] },
      ] };
    }
    case "List":
      return { tag: "div", style: { display: "flex", flexDirection: "column", gap: num(p.gap, 4), padding: num(p.padding, 0) }, children: kids() };
    case "ListItem": {
      const extra = str(p.extra);
      return { tag: "div", style: { display: "flex", alignItems: "center", gap: 14, padding: "12px 8px", borderRadius: t.radius }, children: [
        ...(p.icon ? [{ tag: "span", style: {
          width: 36, height: 36, borderRadius: t.radius, background: t.surface, flexShrink: 0,
          display: "flex", alignItems: "center", justifyContent: "center", color: t.text }, children: [icon(p.icon, 17)] }] : []),
        { tag: "div", style: { flex: 1, minWidth: 0 }, children: [
          { tag: "div", text: str(p.title), style: { fontSize: 14, fontWeight: 500, color: t.text } },
          ...(p.desc ? [{ tag: "div", text: str(p.desc), style: { fontSize: 12, color: t.mutedText, marginTop: 2 } }] : []),
        ] },
        ...(extra.startsWith("switch") ? [nodeToIR2("Switch", { on: extra.endsWith("on") }, ctx)]
          : extra ? [{ tag: "span", text: extra.replace(/^text/, ""), style: { fontSize: 12, color: t.mutedText } }] : []),
      ] };
    }
    case "Avatar": {
      const size = num(p.size, 40);
      const name = str(p.name, "U");
      return { tag: "span", text: name.slice(0, 1), style: {
        width: size, height: size, borderRadius: 999, flexShrink: 0, background: gradientFor(name),
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        fontSize: size * 0.38, fontWeight: 600, color: "#fff" } };
    }
    case "Statistic": {
      const up = bool(p.trendUp, true);
      return { tag: "div", style: { ...cardStyle(t), padding: 20 }, children: [
        { tag: "div", style: { display: "flex", alignItems: "center", justifyContent: "space-between" }, children: [
          { tag: "span", text: str(p.label), style: { fontSize: 14, color: t.mutedText } },
          ...(p.icon ? [{ tag: "span", style: {
            width: 32, height: 32, borderRadius: t.radius, display: "flex", alignItems: "center", justifyContent: "center",
            background: `color-mix(in srgb, ${t.accent} 10%, transparent)`, color: t.accent }, children: [icon(p.icon, 16)] }] : []),
        ] },
        { tag: "div", text: str(p.value), style: { fontSize: 28, fontWeight: 700, color: t.text, marginTop: 8 } },
        ...(p.trend ? [{ tag: "div", text: str(p.trend), style: { fontSize: 12, marginTop: 4, color: up ? "#16a34a" : "#dc2626" } }] : []),
      ] };
    }
    case "Progress": {
      const value = num(p.value, 60);
      return { tag: "div", style: { width: "100%" }, children: [
        ...(p.label ? [{ tag: "div", style: { display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 6 }, children: [
          { tag: "span", text: str(p.label), style: { color: t.text } },
          { tag: "span", text: `${value}%`, style: { color: t.mutedText } },
        ] }] : []),
        { tag: "div", style: { height: 8, borderRadius: 999, background: "rgba(0,0,0,0.07)", overflow: "hidden" }, children: [
          { tag: "div", style: { height: "100%", borderRadius: 999, background: t.accent, width: `${value}%` } } ] },
      ] };
    }
    case "Chart":
      return { tag: "div", html: chartSvg(p, t.accent), style: { width: "100%" } };
    case "Timeline": {
      const items = arr<{ title: string; desc?: string; time?: string }>(p.items);
      return { tag: "div", style: { display: "flex", flexDirection: "column" }, children: items.map((it, i): IRNode => ({
        tag: "div", style: { display: "flex", gap: 14 }, children: [
          { tag: "div", style: { display: "flex", flexDirection: "column", alignItems: "center" }, children: [
            { tag: "span", style: { width: 10, height: 10, borderRadius: 999, background: i === 0 ? t.accent : "rgba(0,0,0,0.15)", marginTop: 6 } },
            ...(i < items.length - 1 ? [{ tag: "span", style: { flex: 1, width: 2, background: "rgba(0,0,0,0.08)" } }] : []),
          ] },
          { tag: "div", style: { paddingBottom: 20 }, children: [
            { tag: "div", text: it.title, style: { fontSize: 14, fontWeight: 500, color: t.text } },
            ...(it.desc ? [{ tag: "div", text: it.desc, style: { fontSize: 12, color: t.mutedText, marginTop: 2 } }] : []),
            ...(it.time ? [{ tag: "div", text: it.time, style: { fontSize: 11, color: t.mutedText, marginTop: 2 } }] : []),
          ] },
        ] })) };
    }
    case "Rating": {
      const value = num(p.value, 4);
      return { tag: "span", style: { display: "inline-flex", gap: 2, fontSize: 16, width: "fit-content" },
        children: [1, 2, 3, 4, 5].map((i): IRNode => ({ tag: "span", text: "★", style: { color: i <= value ? "#f59e0b" : "rgba(0,0,0,0.15)" } })) };
    }
    case "Empty":
      return { tag: "div", style: { display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "40px 0", color: t.mutedText }, children: [
        icon(str(p.icon, "image") || "image", 28),
        { tag: "span", text: str(p.title, "暂无数据"), style: { fontSize: 14 } },
        ...(p.text ? [{ tag: "span", text: str(p.text), style: { fontSize: 12 } }] : []),
      ] };

    // ---------- 导航 ----------
    case "NavLinks":
      return { tag: "nav", style: { display: "flex", gap: 24 }, children: arr<string>(p.links).map((l): IRNode => ({
        tag: "a", text: l, attrs: { href: ctx.link?.(l) ?? "#" }, style: { fontSize: 14, color: t.mutedText, textDecoration: "none", cursor: "pointer" } })) };
    case "Breadcrumb":
      return { tag: "div", style: { display: "flex", alignItems: "center", gap: 6, fontSize: 14, color: t.mutedText },
        children: arr<string>(p.items).flatMap((it, i, a): IRNode[] => [
          { tag: "span", text: it, style: (i === a.length - 1 ? { color: t.text, fontWeight: 500 } : {}) as Record<string, string | number> },
          ...(i < a.length - 1 ? [{ tag: "span", text: "›", style: { opacity: 0.5 } } as IRNode] : []),
        ]) };
    case "Pagination":
      return { tag: "div", style: { display: "flex", gap: 4, justifyContent: "center" },
        children: ["‹", "1", "2", "3", "…", "9", "›"].map((pg, i): IRNode => ({
          tag: "span", text: pg, style: {
            width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 14, borderRadius: t.radius, cursor: "pointer",
            ...(i === 1 ? { background: t.primary, color: "#fff" } : { color: t.mutedText }) } })) };
    case "Steps": {
      const current = num(p.current, 1);
      return { tag: "div", style: { display: "flex", alignItems: "center", width: "100%" },
        children: arr<string>(p.items).flatMap((s, i, a): IRNode[] => {
          const done = i < current;
          return [
            { tag: "div", style: { display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }, children: [
              { tag: "span", text: done ? "✓" : String(i + 1), style: {
                width: 28, height: 28, borderRadius: 999, display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 12, fontWeight: 600, ...(done ? { background: t.primary, color: "#fff" } : { background: "rgba(0,0,0,0.07)", color: t.mutedText }) } },
              { tag: "span", text: s, style: { fontSize: 12, color: done ? t.text : t.mutedText } },
            ] },
            ...(i < a.length - 1 ? [{ tag: "span", style: { flex: 1, height: 1, margin: "0 8px 20px", background: i < current - 1 ? t.primary : "rgba(0,0,0,0.1)" } } as IRNode] : []),
          ];
        }) };
    }
    case "TabBar":
      return { tag: "nav", style: {
        position: "sticky", bottom: 0, marginTop: "auto", background: "#fff", zIndex: 20,
        borderTop: "1px solid rgba(0,0,0,0.07)", padding: "6px 8px", display: "flex", justifyContent: "space-around" },
        children: arr<{ icon: string; label: string; active?: boolean }>(p.items).map((it): IRNode => ({
          tag: "div", style: {
            display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "4px 12px",
            cursor: "pointer", color: it.active ? t.accent : t.mutedText }, children: [
            icon(it.icon, 20),
            { tag: "span", text: it.label, style: { fontSize: 10 } },
          ] })) };

    // ---------- 反馈 ----------
    case "Alert": {
      const kind = str(p.kind, "info");
      const style: Record<string, string | number> =
        kind === "warning" ? { background: "#fffbeb", color: "#92400e", border: "1px solid #fde68a" }
        : kind === "error" ? { background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca" }
        : kind === "success" ? { background: "#f0fdf4", color: "#15803d", border: "1px solid #bbf7d0" }
        : { background: "#eff6ff", color: "#1d4ed8", border: "1px solid #bfdbfe" };
      return { tag: "div", style: { padding: "12px 16px", fontSize: 14, borderRadius: t.radius, ...style }, children: [
        { tag: "strong", text: str(p.title) }, { tag: "span", text: ` ${str(p.text)}` },
      ] };
    }
    case "Skeleton":
      return { tag: "div", style: { display: "flex", flexDirection: "column", gap: 10, width: "100%" },
        children: Array.from({ length: num(p.lines, 3) }).map((_, i): IRNode => ({
          tag: "div", style: { height: 14, borderRadius: 6, background: "rgba(0,0,0,0.07)", width: `${90 - i * 15}%` } })) };

    // ---------- 媒体 ----------
    case "Image": {
      const width = num(p.width, 0);
      const [rw, rh] = str(p.ratio, "16:9").split(":").map(Number);
      return { tag: "div", style: {
        width: width || "100%", aspectRatio: `${rw || 16}/${rh || 9}`, flexShrink: 0,
        borderRadius: bool(p.rounded) ? t.radius : 0, overflow: "hidden",
        background: gradientFor(str(p.alt, "img")), display: "flex", alignItems: "center", justifyContent: "center",
        color: "rgba(255,255,255,0.85)" }, children: [icon("image", 26)] };
    }
    case "Icon": {
      const size = num(p.size, 20);
      if (bool(p.boxed)) return { tag: "span", style: {
        width: 44, height: 44, borderRadius: t.radius, display: "inline-flex", alignItems: "center", justifyContent: "center",
        background: `color-mix(in srgb, ${t.accent} 10%, transparent)`, color: t.accent }, children: [icon(p.name, size)] };
      return icon(p.name, size, { color: t.text });
    }
    case "LogoCloud":
      return { tag: "section", style: {
        padding: "40px 0", borderTop: "1px solid rgba(0,0,0,0.05)", borderBottom: "1px solid rgba(0,0,0,0.05)",
        background: "rgba(255,255,255,0.6)", textAlign: "center" }, children: [
        ...(p.title ? [{ tag: "p", text: str(p.title), style: { fontSize: 13, color: t.mutedText, marginBottom: 20 } }] : []),
        { tag: "div", style: { display: "flex", flexWrap: "wrap", gap: "12px 40px", justifyContent: "center", alignItems: "center" },
          children: arr<string>(p.logos).map((l): IRNode => ({ tag: "span", text: l, style: { fontSize: 17, fontWeight: 600, color: "rgba(0,0,0,0.35)" } })) },
      ] };

    // ---------- 营销组合 ----------
    case "FeatureGrid": {
      const features = arr<{ icon: string; title: string; desc: string }>(p.features);
      return { tag: "section", style: { padding: "72px 24px" }, children: [
        { tag: "div", style: { maxWidth: 1080, margin: "0 auto" }, children: [
          ...(p.title ? [{ tag: "h2", text: str(p.title), style: { fontSize: 32, fontWeight: 700, textAlign: "center", color: t.text, margin: "0 0 8px" } }] : []),
          ...(p.subtitle ? [{ tag: "p", text: str(p.subtitle), style: { fontSize: 16, color: t.mutedText, textAlign: "center", margin: "0 0 44px" } }] : []),
          { tag: "div", style: { display: "grid", gridTemplateColumns: `repeat(${num(p.columns, 3)}, minmax(0,1fr))`, gap: 20 },
            children: features.map((f): IRNode => ({ tag: "div", style: { ...cardStyle(t), padding: 24 }, children: [
              { tag: "span", style: {
                width: 40, height: 40, borderRadius: t.radius, display: "flex", alignItems: "center", justifyContent: "center",
                background: `color-mix(in srgb, ${t.accent} 10%, transparent)`, color: t.accent, marginBottom: 14 }, children: [icon(f.icon, 19)] },
              { tag: "div", text: f.title, style: { fontSize: 15, fontWeight: 600, color: t.text } },
              { tag: "div", text: f.desc, style: { fontSize: 13, color: t.mutedText, marginTop: 6, lineHeight: 1.6 } },
            ] })) },
        ] },
      ] };
    }
    case "PricingTable": {
      const plans = arr<{ name: string; price: string; period?: string; features: string[]; highlighted?: boolean; cta?: string }>(p.plans);
      return { tag: "section", style: { padding: "72px 24px" }, children: [
        { tag: "div", style: { maxWidth: 1080, margin: "0 auto" }, children: [
          ...(p.title ? [{ tag: "h2", text: str(p.title), style: { fontSize: 32, fontWeight: 700, textAlign: "center", color: t.text, margin: "0 0 8px" } }] : []),
          ...(p.subtitle ? [{ tag: "p", text: str(p.subtitle), style: { fontSize: 16, color: t.mutedText, textAlign: "center", margin: "0 0 44px" } }] : []),
          { tag: "div", style: { display: "grid", gridTemplateColumns: `repeat(${plans.length || 3}, minmax(0,1fr))`, gap: 20, alignItems: "stretch" },
            children: plans.map((pl): IRNode => ({ tag: "div", style: {
              ...cardStyle(t), padding: 28, display: "flex", flexDirection: "column",
              ...(pl.highlighted ? { border: `2px solid ${t.primary}`, boxShadow: "0 8px 30px rgba(0,0,0,0.1)" } : {}) }, children: [
              ...(pl.highlighted ? [{ tag: "span", text: "推荐", style: {
                alignSelf: "flex-start", padding: "2px 10px", fontSize: 11, fontWeight: 600, borderRadius: 999,
                background: t.primary, color: "#fff", marginBottom: 12 } }] : []),
              { tag: "div", text: pl.name, style: { fontSize: 16, fontWeight: 600, color: t.text } },
              { tag: "div", style: { margin: "12px 0 20px" }, children: [
                { tag: "span", text: pl.price, style: { fontSize: 34, fontWeight: 800, color: t.text } },
                { tag: "span", text: pl.period ?? "/月", style: { fontSize: 13, color: t.mutedText } },
              ] },
              { tag: "div", style: { display: "flex", flexDirection: "column", gap: 10, flex: 1 },
                children: (pl.features ?? []).map((f): IRNode => ({ tag: "div", style: { display: "flex", gap: 8, fontSize: 13, color: t.text }, children: [
                  { tag: "span", text: "✓", style: { color: "#16a34a", fontWeight: 700 } }, { tag: "span", text: f },
                ] })) },
              { tag: "button", text: pl.cta ?? "选择方案", style: { ...buttonStyle(t, pl.highlighted ? "primary" : "outline"), width: "100%", justifyContent: "center", marginTop: 24 } },
            ] })) },
        ] },
      ] };
    }
    case "TestimonialCard":
      return { tag: "div", style: { ...cardStyle(t), padding: 24 }, children: [
        { tag: "div", style: { display: "flex", gap: 2, color: "#f59e0b", fontSize: 14, marginBottom: 12 }, children:
          Array.from({ length: num(p.stars, 5) }).map((): IRNode => ({ tag: "span", text: "★" })) },
        { tag: "p", text: `“${str(p.quote)}”`, style: { fontSize: 14, color: t.text, lineHeight: 1.7, margin: 0 } },
        { tag: "div", style: { display: "flex", alignItems: "center", gap: 10, marginTop: 16 }, children: [
          { tag: "span", text: str(p.author, "U").slice(0, 1), style: {
            width: 36, height: 36, borderRadius: 999, background: gradientFor(str(p.author, "U")),
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 600, color: "#fff" } },
          { tag: "div", children: [
            { tag: "div", text: str(p.author), style: { fontSize: 13, fontWeight: 600, color: t.text } },
            { tag: "div", text: str(p.role), style: { fontSize: 12, color: t.mutedText } },
          ] },
        ] },
      ] };
    case "StatsRow":
      return { tag: "div", style: { display: "grid", gridTemplateColumns: `repeat(${arr(p.stats).length || 4}, minmax(0,1fr))`, gap: 16 },
        children: arr<{ value: string; label: string }>(p.stats).map((s): IRNode => ({ tag: "div", style: { textAlign: "center", padding: "20px 8px" }, children: [
          { tag: "div", text: s.value, style: { fontSize: 30, fontWeight: 800, color: t.primary } },
          { tag: "div", text: s.label, style: { fontSize: 13, color: t.mutedText, marginTop: 4 } },
        ] })) };
    case "CTASection":
      return { tag: "section", style: {
        textAlign: "center", padding: "72px 24px", margin: 16, borderRadius: t.radius * 1.6,
        background: `linear-gradient(135deg, ${t.primary}, color-mix(in srgb, ${t.primary} 70%, ${t.accent}))`, color: "#fff" }, children: [
        { tag: "h2", text: str(p.title), style: { fontSize: 30, fontWeight: 700, margin: 0 } },
        ...(p.subtitle ? [{ tag: "p", text: str(p.subtitle), style: { fontSize: 15, opacity: 0.85, maxWidth: 560, margin: "14px auto 0" } }] : []),
        ...(p.cta ? [{ tag: "button", text: str(p.cta), style: {
          marginTop: 28, padding: "12px 28px", fontSize: 15, fontWeight: 600, borderRadius: t.radius,
          background: "#fff", color: t.primary, border: "none", cursor: "pointer" } }] : []),
      ] };
    case "FAQ":
      return { tag: "div", style: { display: "flex", flexDirection: "column", gap: 12, width: "100%" },
        children: arr<{ q: string; a: string }>(p.items).map((f, i): IRNode => ({ tag: "div", style: { ...cardStyle(t), padding: "16px 20px" }, children: [
          { tag: "div", style: { display: "flex", justifyContent: "space-between", alignItems: "center" }, children: [
            { tag: "span", text: f.q, style: { fontSize: 14, fontWeight: 600, color: t.text } },
            { tag: "span", text: i === 0 ? "−" : "+", style: { color: t.mutedText, fontSize: 16 } },
          ] },
          ...(i === 0 ? [{ tag: "p", text: f.a, style: { fontSize: 13, color: t.mutedText, margin: "10px 0 0", lineHeight: 1.6 } }] : []),
        ] })) };
    case "ProductCard": {
      const name = str(p.name, "商品");
      return { tag: "div", style: { ...cardStyle(t), overflow: "hidden" }, children: [
        { tag: "div", style: {
          aspectRatio: "1/1", background: gradientFor(name), display: "flex", alignItems: "center",
          justifyContent: "center", color: "rgba(255,255,255,0.85)", position: "relative" }, children: [
          icon("image", 28),
          ...(p.tag ? [{ tag: "span", text: str(p.tag), style: {
            position: "absolute", top: 12, left: 12, padding: "2px 8px", fontSize: 11, fontWeight: 600,
            borderRadius: 999, background: "rgba(255,255,255,0.92)", color: t.text } }] : []),
        ] },
        { tag: "div", style: { padding: 14 }, children: [
          { tag: "div", text: name, style: { fontSize: 14, fontWeight: 500, color: t.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } },
          { tag: "div", style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }, children: [
            { tag: "span", text: str(p.price), style: { fontSize: 15, fontWeight: 700, color: "#dc2626" } },
            { tag: "span", text: `★ ${str(p.rating, "4.8")}`, style: { fontSize: 12, color: t.mutedText } },
          ] },
        ] },
      ] };
    }
    default:
      return { tag: "div", text: `[${n.type}]`, style: { padding: 8, fontSize: 12, color: "#999" } };
  }
}

/** 供 ListItem 等内部组合使用 */
function nodeToIR2(type: string, props: Record<string, unknown>, ctx: Ctx): IRNode {
  const tmpId = `__tmp_${type}`;
  const doc: SurfaceDoc = { ...ctx.doc, components: { ...ctx.doc.components, [tmpId]: { type, props, children: [] } as ComponentNode } };
  return nodeToIR(tmpId, { ...ctx, doc })!;
}

// ---------------------------------------------------------------------------
// 静态 SVG 图表(bar / line / area / pie)
// ---------------------------------------------------------------------------
const PALETTE = ["#6366f1", "#22c55e", "#f59e0b", "#ec4899", "#06b6d4", "#8b5cf6"];

function chartSvg(p: Record<string, unknown>, accent: string): string {
  const cats = arr<string>(p.categories);
  const sers = arr<{ name?: string; data?: number[] }>(p.series).map((s) => ({ name: str(s?.name, "系列"), data: arr<number>(s?.data) }));
  const h = num(p.height, 260), w = 720;
  const padL = 40, padB = 28, padT = 16;
  const iw = w - padL - 16, ih = h - padT - padB;
  const max = Math.max(1, ...sers.flatMap((s) => s.data));
  const k = str(p.kind, "bar");
  const color = (i: number) => (i === 0 ? accent || PALETTE[0] : PALETTE[i % PALETTE.length]);
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

  if (!cats.length || !sers.length)
    return `<div style="height:${h}px;display:flex;align-items:center;justify-content:center;font-size:14px;opacity:.5">暂无数据</div>`;

  const xStep = iw / cats.length;
  const y = (v: number) => padT + ih - (v / max) * ih;
  let body = [0.25, 0.5, 0.75, 1].map((f) =>
    `<line x1="${padL}" x2="${w - 16}" y1="${padT + ih * (1 - f)}" y2="${padT + ih * (1 - f)}" stroke="currentColor" stroke-opacity="0.08"/>`).join("");

  if (k === "bar") {
    const groupW = xStep * 0.62;
    const barW = Math.min(38, groupW / sers.length - 4);
    body += sers.map((s, si) => s.data.map((v, ci) => {
      const x = padL + ci * xStep + (xStep - groupW) / 2 + si * (barW + 4);
      return `<rect x="${x}" y="${y(v)}" width="${barW}" height="${padT + ih - y(v)}" rx="4" fill="${color(si)}" opacity="0.92"><title>${esc(cats[ci])} · ${esc(s.name)}: ${v}</title></rect>`;
    }).join("")).join("");
  } else if (k === "pie") {
    const data = sers[0].data;
    const total = data.reduce((a, b) => a + b, 0) || 1;
    const cx = w / 2, cy = padT + ih / 2, r = Math.min(iw, ih) / 2 - 8;
    let angle = -Math.PI / 2;
    body += data.map((v, i) => {
      const a2 = angle + (v / total) * Math.PI * 2;
      const large = a2 - angle > Math.PI ? 1 : 0;
      const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
      const x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
      angle = a2;
      return `<path d="M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} Z" fill="${color(i)}" opacity="0.92"><title>${esc(cats[i])}: ${v}</title></path>`;
    }).join("");
  } else {
    body += sers.map((s, si) => {
      const pts = s.data.map((v, ci) => [padL + ci * xStep + xStep / 2, y(v)] as const);
      const path = pts.map(([x, yy], i) => `${i ? "L" : "M"}${x},${yy}`).join(" ");
      const area = k === "area" ? `<path d="${path} L${pts[pts.length - 1]?.[0]},${padT + ih} L${pts[0]?.[0]},${padT + ih} Z" fill="${color(si)}" opacity="0.14"/>` : "";
      const dots = pts.map(([x, yy], i) => `<circle cx="${x}" cy="${yy}" r="3.5" fill="#fff" stroke="${color(si)}" stroke-width="2"><title>${esc(cats[i])} · ${esc(s.name)}: ${s.data[i]}</title></circle>`).join("");
      return `${area}<path d="${path}" fill="none" stroke="${color(si)}" stroke-width="2.5" stroke-linejoin="round"/>${dots}`;
    }).join("");
  }

  const labels = k !== "pie" ? cats.map((c, i) =>
    `<text x="${padL + i * xStep + xStep / 2}" y="${h - 8}" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.5">${esc(c)}</text>`).join("") : "";
  const legendItems = k === "pie" ? cats : sers.map((s) => s.name);
  const legend = (sers.length > 1 || k === "pie")
    ? `<div style="display:flex;gap:16px;justify-content:center;margin-top:4px;flex-wrap:wrap">${legendItems.map((nm, i) =>
        `<span style="display:flex;align-items:center;gap:6px;font-size:12px;opacity:.75"><span style="display:inline-block;width:8px;height:8px;border-radius:999px;background:${color(i)}"></span>${esc(String(nm))}</span>`).join("")}</div>`
    : "";

  return `<div style="width:100%;overflow:hidden;color:inherit"><svg viewBox="0 0 ${w} ${h}" style="width:100%;height:${h}px">${body}${labels}</svg>${legend}</div>`;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
export function surfaceToIR(doc: SurfaceDoc, opts?: { resolveLink?: (label: string) => string | undefined }): IRNode {
  const ctx: Ctx = {
    doc,
    t: doc.theme.tokens,
    render: (cid) => nodeToIR(cid, ctx),
    link: opts?.resolveLink,
  };
  const tree = ctx.render(doc.root);
  const t = doc.theme.tokens;
  return {
    tag: "div",
    style: {
      minHeight: "100vh", width: "100%", background: t.background, color: t.text,
      fontFamily: t.font || "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
      display: "flex", flexDirection: "column",
    },
    children: tree ? [tree] : [],
  };
}
