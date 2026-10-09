import { z } from "zod";

/**
 * A2UI DSL v1 —— 声明式 UI 组件树协议（前后端共享）
 *
 * 设计要点:
 * - 扁平组件表 + children 邻接表,利于流式生成与增量 patch
 * - 组件类型与风格解耦:同一份 SurfaceDoc 可被任意预设渲染器(antd / shadcn / custom)渲染
 * - 修改走 ops(JSON Patch 风格),不重生成整页
 */

// ---------------------------------------------------------------------------
// 设备预设
// ---------------------------------------------------------------------------
export const DEVICES = {
  desktop: { id: "desktop", label: "桌面", width: 1440, height: 900 },
  laptop: { id: "laptop", label: "笔记本", width: 1280, height: 800 },
  tablet: { id: "tablet", label: "平板", width: 768, height: 1024 },
  mobile: { id: "mobile", label: "手机", width: 390, height: 844 },
} as const;
export type DeviceId = keyof typeof DEVICES;
export const DEVICE_IDS = Object.keys(DEVICES) as DeviceId[];

// ---------------------------------------------------------------------------
// 风格预设
// ---------------------------------------------------------------------------
export const STYLE_PRESETS = {
  shadcn: { id: "shadcn", label: "shadcn/ui", desc: "现代简约 · Tailwind" },
  antd: { id: "antd", label: "Ant Design", desc: "企业级 · 中后台" },
  element: { id: "element", label: "Element UI", desc: "饿了么开源 · 经典中后台" },
  custom: { id: "custom", label: "AI 自定义", desc: "AI 生成设计令牌" },
} as const;
export type PresetId = keyof typeof STYLE_PRESETS;
export const PRESET_IDS = Object.keys(STYLE_PRESETS) as PresetId[];

/** 各预设的默认设计令牌(切换预设 / 新建文档时的品牌基准,AI 可在其基础上按品牌微调) */
export const PRESET_TOKENS: Record<PresetId, ThemeTokens> = {
  shadcn: { primary: "#18181b", background: "#ffffff", surface: "#f4f4f5", text: "#09090b", mutedText: "#71717a", accent: "#2563eb", radius: 10, font: "" },
  antd: { primary: "#1677ff", background: "#f5f5f5", surface: "#ffffff", text: "rgba(0,0,0,0.88)", mutedText: "rgba(0,0,0,0.45)", accent: "#1677ff", radius: 6, font: "" },
  element: { primary: "#409eff", background: "#f5f7fa", surface: "#ffffff", text: "#303133", mutedText: "#909399", accent: "#409eff", radius: 4, font: "" },
  custom: { primary: "#18181b", background: "#ffffff", surface: "#f4f4f5", text: "#09090b", mutedText: "#71717a", accent: "#2563eb", radius: 10, font: "" },
};

// ---------------------------------------------------------------------------
// 主题令牌
// ---------------------------------------------------------------------------
export const themeTokensSchema = z.object({
  primary: z.string().default("#18181b"),
  background: z.string().default("#ffffff"),
  surface: z.string().default("#f4f4f5"),
  text: z.string().default("#09090b"),
  mutedText: z.string().default("#71717a"),
  accent: z.string().default("#2563eb"),
  radius: z.number().default(10),
  font: z.string().default(""),
});
export type ThemeTokens = z.infer<typeof themeTokensSchema>;
export const DEFAULT_TOKENS: ThemeTokens = themeTokensSchema.parse({});

// ---------------------------------------------------------------------------
// 组件目录(MVP ~40 个)
// ---------------------------------------------------------------------------
export const CATALOG_GROUPS: { group: string; types: string[] }[] = [
  {
    group: "布局",
    types: [
      "Navbar", "Hero", "Section", "Container", "Row", "Col", "Grid",
      "Card", "Footer", "Divider", "Tabs", "SidebarLayout",
    ],
  },
  {
    group: "排版",
    types: ["Title", "Text", "Link", "Badge", "Tag"],
  },
  {
    group: "表单",
    types: [
      "Button", "Input", "Textarea", "Select", "Checkbox", "Switch",
      "SearchBar", "LoginForm", "Form",
    ],
  },
  {
    group: "数据",
    types: [
      "Table", "List", "ListItem", "Avatar", "Statistic", "Progress",
      "Chart", "Timeline", "Rating", "Empty",
    ],
  },
  {
    group: "导航",
    types: ["NavLinks", "Breadcrumb", "Pagination", "Steps", "TabBar"],
  },
  {
    group: "反馈",
    types: ["Alert", "Skeleton"],
  },
  {
    group: "媒体",
    types: ["Image", "Icon", "LogoCloud"],
  },
  {
    group: "营销组合",
    types: [
      "FeatureGrid", "PricingTable", "TestimonialCard", "StatsRow",
      "CTASection", "FAQ", "ProductCard",
    ],
  },
];
export const CATALOG_TYPES = CATALOG_GROUPS.flatMap((g) => g.types);
export const catalogTypeSchema = z.enum(CATALOG_TYPES as [string, ...string[]]);

/**
 * 可包含子节点的容器类型(其余 Catalog 类型视为叶子)。
 * Validation layout 层与左栏组件库插入目标判定共用;前端不引 api 层,故放契约层。
 */
export const CONTAINER_TYPES = new Set<string>([
  "Navbar", "Hero", "Section", "Container", "Row", "Col", "Grid", "Card", "Footer", "Tabs",
  "SidebarLayout", "List", "Timeline", "Form", "ListItem", "Table",
  "FeatureGrid", "PricingTable", "FAQ", "CTASection", "StatsRow",
]);

// ---------------------------------------------------------------------------
// A2UI 文档
// ---------------------------------------------------------------------------
export const componentNodeSchema = z.object({
  type: catalogTypeSchema,
  props: z.record(z.string(), z.unknown()).default({}),
  children: z.array(z.string()).default([]),
});
export type ComponentNode = z.infer<typeof componentNodeSchema>;

export const surfaceDocSchema = z.object({
  version: z.literal("1.0").default("1.0"),
  page: z.object({
    id: z.string(),
    title: z.string(),
    device: z.enum(DEVICE_IDS as [DeviceId, ...DeviceId[]]).default("desktop"),
  }),
  theme: z
    .object({
      preset: z.enum(PRESET_IDS as [PresetId, ...PresetId[]]).default("shadcn"),
      tokens: themeTokensSchema.default(DEFAULT_TOKENS),
    })
    .default({ preset: "shadcn", tokens: DEFAULT_TOKENS }),
  components: z.record(z.string(), componentNodeSchema),
  root: z.string(),
});
export type SurfaceDoc = z.infer<typeof surfaceDocSchema>;

/** 深度校验:节点引用完整、无环 */
export function validateSurface(doc: SurfaceDoc): string[] {
  const errors: string[] = [];
  if (!doc.components[doc.root]) errors.push(`root "${doc.root}" 不存在`);
  const visited = new Set<string>();
  const walk = (id: string, stack: string[]) => {
    const node = doc.components[id];
    if (!node) {
      errors.push(`组件 "${id}" 被引用但不存在`);
      return;
    }
    if (stack.includes(id)) {
      errors.push(`检测到循环引用: ${[...stack, id].join(" → ")}`);
      return;
    }
    if (visited.has(id)) return;
    visited.add(id);
    node.children.forEach((c) => walk(c, [...stack, id]));
  };
  walk(doc.root, []);
  return errors;
}

// ---------------------------------------------------------------------------
// Ops —— 增量补丁
// ---------------------------------------------------------------------------
export const surfaceOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("replaceProps"),
    id: z.string(),
    props: z.record(z.string(), z.unknown()),
  }),
  z.object({
    op: z.literal("addNode"),
    parentId: z.string(),
    index: z.number().int().optional(),
    id: z.string(),
    node: componentNodeSchema,
    /** 附带的子孙节点 */
    extra: z.record(z.string(), componentNodeSchema).default({}),
  }),
  z.object({ op: z.literal("removeNode"), id: z.string() }),
  z.object({
    op: z.literal("moveNode"),
    id: z.string(),
    newParentId: z.string(),
    index: z.number().int().optional(),
  }),
  z.object({ op: z.literal("setTokens"), tokens: themeTokensSchema.partial() }),
  z.object({ op: z.literal("setTitle"), title: z.string() }),
]);
export type SurfaceOp = z.infer<typeof surfaceOpSchema>;

/** 应用 ops,返回新 doc(不可变) */
export function applyOps(doc: SurfaceDoc, ops: SurfaceOp[]): SurfaceDoc {
  const next: SurfaceDoc = JSON.parse(JSON.stringify(doc));
  for (const op of ops) {
    switch (op.op) {
      case "replaceProps": {
        const n = next.components[op.id];
        if (n) n.props = { ...n.props, ...op.props };
        break;
      }
      case "addNode": {
        const parent = next.components[op.parentId];
        if (!parent) break;
        next.components[op.id] = op.node;
        for (const [k, v] of Object.entries(op.extra ?? {})) next.components[k] = v;
        const idx = op.index ?? parent.children.length;
        parent.children = [
          ...parent.children.slice(0, idx),
          op.id,
          ...parent.children.slice(idx),
        ].filter((c, i, arr) => arr.indexOf(c) === i);
        break;
      }
      case "removeNode": {
        const removeRecursive = (id: string) => {
          const n = next.components[id];
          if (!n) return;
          n.children.forEach(removeRecursive);
          delete next.components[id];
        };
        removeRecursive(op.id);
        for (const n of Object.values(next.components)) {
          n.children = n.children.filter((c) => c !== op.id);
        }
        break;
      }
      case "moveNode": {
        const target = next.components[op.id];
        const newParent = next.components[op.newParentId];
        if (!target || !newParent) break;
        for (const n of Object.values(next.components)) {
          n.children = n.children.filter((c) => c !== op.id);
        }
        const idx = op.index ?? newParent.children.length;
        newParent.children.splice(idx, 0, op.id);
        break;
      }
      case "setTokens": {
        next.theme.tokens = { ...next.theme.tokens, ...op.tokens };
        break;
      }
      case "setTitle": {
        next.page.title = op.title;
        break;
      }
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// 对话动作(LLM 管线的输出)
// ---------------------------------------------------------------------------
export type ContextChip =
  | { kind: "page"; pageId: string; title: string }
  | { kind: "element"; pageId: string; aid: string; label: string };

export type ChatAction =
  | {
      type: "createPage";
      pageId: string;
      title: string;
      device: DeviceId;
      surface: SurfaceDoc;
    }
  | { type: "updateSurface"; pageId: string; surface: SurfaceDoc }
  | { type: "ops"; pageId: string; ops: SurfaceOp[]; summary: string }
  | { type: "setPreset"; preset: PresetId };

export interface ChatGenerateResult {
  assistantText: string;
  actions: ChatAction[];
  engine: "kimi";
  /** 实际调用的模型名(界面展示用;历史消息可能缺省) */
  model?: string;
  steps: ChatStep[];
  /** Plan 模式:仅提案,不落地 */
  plan?: EditPlan;
}

/** 引擎显示名。kimi 通道实为 OpenAI 兼容协议,可指向任意兼容服务,
 *  按模型/端点推断真实服务商,避免配置指向 DeepSeek 等服务时界面仍显示「Kimi」 */
export function engineDisplayName(
  engine: string | null | undefined,
  model?: string | null,
  baseUrl?: string | null,
): string {
  if (engine === "kimi") {
    const hint = `${model ?? ""} ${baseUrl ?? ""}`.toLowerCase();
    if (hint.includes("deepseek")) return "DeepSeek";
    if (hint.includes("kimi") || hint.includes("moonshot")) return "Kimi";
    if (hint.includes("openai") || /gpt-|o[134]-/.test(hint)) return "OpenAI";
    if (hint.includes("qwen") || hint.includes("dashscope")) return "Qwen";
    if (hint.includes("glm") || hint.includes("zhipu")) return "GLM";
    if (model) return model;
    return "OpenAI 兼容";
  }
  return "AI 生成";
}

export const chatActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("createPage"),
    pageId: z.string(),
    title: z.string(),
    device: z.enum(DEVICE_IDS as [DeviceId, ...DeviceId[]]),
    surface: surfaceDocSchema,
  }),
  z.object({ type: z.literal("updateSurface"), pageId: z.string(), surface: surfaceDocSchema }),
  z.object({
    type: z.literal("ops"),
    pageId: z.string(),
    ops: z.array(surfaceOpSchema),
    summary: z.string(),
  }),
  z.object({ type: z.literal("setPreset"), preset: z.enum(PRESET_IDS as [PresetId, ...PresetId[]]) }),
]);

export interface EditPlanItem {
  description: string;
  risk: "low" | "medium";
}
export interface EditPlan {
  summary: string;
  items: EditPlanItem[];
  risk: "low" | "medium";
}

/** 将动作清单翻译为人类可读的计划(Plan 模式审批卡) */
export function planFromActions(actions: ChatAction[]): EditPlan {
  const items: EditPlanItem[] = [];
  const opText = (op: SurfaceOp): EditPlanItem => {
    switch (op.op) {
      case "replaceProps": {
        const keys = Object.keys(op.props).join("、");
        return { description: `修改组件 ${op.id} 的属性(${keys})`, risk: "low" };
      }
      case "addNode":
        return { description: `在 ${op.parentId} 下新增 ${op.node.type} 组件 ${op.id}`, risk: "low" };
      case "removeNode":
        return { description: `删除组件 ${op.id} 及其子树`, risk: "medium" };
      case "moveNode":
        return { description: `移动组件 ${op.id} → ${op.newParentId}`, risk: "medium" };
      case "setTokens": {
        const keys = Object.keys(op.tokens).join("、");
        return { description: `更新主题令牌(${keys})`, risk: "low" };
      }
      case "setTitle":
        return { description: `页面标题改为「${op.title}」`, risk: "low" };
    }
  };
  for (const a of actions) {
    if (a.type === "createPage")
      items.push({ description: `新建页面「${a.title}」(${a.device},${Object.keys(a.surface.components).length} 个组件)`, risk: "low" });
    else if (a.type === "updateSurface")
      items.push({ description: `整页重生成 ${a.pageId}(${Object.keys(a.surface.components).length} 个组件)`, risk: "medium" });
    else if (a.type === "ops") items.push(...a.ops.map(opText));
    else if (a.type === "setPreset")
      items.push({ description: `切换项目风格 → ${STYLE_PRESETS[a.preset].label}`, risk: "low" });
  }
  const risk = items.some((i) => i.risk === "medium") ? "medium" : "low";
  return {
    summary: items.length ? `共 ${items.length} 项变更${risk === "medium" ? " · 含高风险操作" : ""}` : "无变更",
    items,
    risk,
  };
}

// ---------------------------------------------------------------------------
// Harness Agent 执行过程
// ---------------------------------------------------------------------------
export type ChatStepStatus = "running" | "done" | "error";
export interface ChatStep {
  /** 稳定标识:running → done/error 的原位更新(同 id 替换);缺省则纯追加 */
  id?: string;
  key: "understand" | "context" | "plan" | "generate" | "validate" | "apply" | "snapshot";
  label: string;
  status: ChatStepStatus;
  detail?: string;
  durationMs?: number;
}

// ---------------------------------------------------------------------------
// Sitemap(两段式站点生成的结构规划:先出页面清单,再逐页生成)
// ---------------------------------------------------------------------------
export const sitemapSchema = z.object({
  pages: z
    .array(
      z.object({
        title: z.string().min(1).max(30),
        purpose: z.string().min(1).max(120),
      }),
    )
    .min(1)
    .max(6),
  /** 全站顶部导航链接文案(顺序即导航顺序) */
  nav: z.array(z.string().min(1).max(20)).min(1).max(8),
});
export type Sitemap = z.infer<typeof sitemapSchema>;

export interface ChatAnalyzeResult {
  mode: "create" | "edit" | "preset";
  intentLabel: string;
  targetTitle?: string;
  engine: "kimi";
  contextSummary: string;
}

// ---------------------------------------------------------------------------
// 图片对话(多模态)
// ---------------------------------------------------------------------------
/** 用户随 prompt 附带的参考图片(data 为 base64,不含 data: 前缀) */
export interface ImageRef {
  name: string;
  /** image/jpeg | image/png | image/webp(多模态消息要求的 media_type) */
  mediaType: string;
  data: string;
}

export const imageRefSchema = z.object({
  name: z.string().max(120),
  mediaType: z.string().max(40),
  data: z.string().max(1_600_000),
});

/** 图片对话开关:auto 按模型名启发式判定 / on 强制开启 / off 关闭(对话不使用图片) */
export type VisionSetting = "auto" | "on" | "off";

/** 模型视觉能力启发式:vision=auto 时据此判定;判定不了的主流多模态型号由用户手动覆盖 */
export function modelSupportsVision(_provider: string, model?: string | null): boolean {
  const m = (model ?? "").toLowerCase();
  return /vision|kimi-latest|kimi-k|gpt-4o|gpt-5|claude|gemini/.test(m);
}

/** 解析最终是否启用图片对话 */
export function resolveVision(setting: VisionSetting | undefined, provider: string, model?: string | null): boolean {
  if (setting === "on") return true;
  if (setting === "off") return false;
  return modelSupportsVision(provider, model);
}

// ---------------------------------------------------------------------------
// 画布内联文本编辑
// ---------------------------------------------------------------------------
/** inspect 模式下可双击编辑文本的组件类型 → 主文本 prop(iframe 渲染器与宿主共用) */
export const TEXT_EDITABLE_PROPS: Record<string, string> = {
  Title: "text",
  Text: "text",
  Button: "label",
  Link: "label",
  Badge: "label",
  Tag: "label",
};
