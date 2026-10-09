import { z } from "zod";
import type { ThemeTokens } from "./a2ui";

/**
 * 风格系统契约(文档 §23)
 *
 * 风格预设不是皮肤按钮,而是一组可执行的 Token、布局、动效、内容和可访问性规则。
 * 四种输入(preset/custom/reference/skill)统一收敛为 StyleDirection,
 * 作为 Prompt、Catalog、Renderer、评审与导出的共同输入。
 */

export const styleSourceSchema = z.enum(["preset", "custom", "reference", "skill", "mixed"]);
export type StyleSource = z.infer<typeof styleSourceSchema>;

/** 内置风格预设(文档 §23.4 的可执行化;前端渲染风格卡片用) */
export const STYLE_DIRECTION_PRESETS = {
  clean_minimal: { label: "Clean Minimal", desc: "内容优先、网格秩序、克制留白", scene: "SaaS、工具、文档" },
  calm_saas: { label: "Calm SaaS", desc: "冷静高效低干扰,类 Linear/Notion", scene: "生产力工具、AI 产品" },
  enterprise_admin: { label: "Enterprise Admin", desc: "稳定、高密度、可扫描", scene: "后台、CRM、运营平台" },
  material_design: { label: "Material Design", desc: "层级、表面、动效规范", scene: "企业应用" },
  apple_hig: { label: "Apple HIG", desc: "清晰、深度、内容中心", scene: "消费级产品" },
  bento_grid: { label: "Bento Grid", desc: "模块化、非对称信息组织", scene: "产品首页、Dashboard" },
  glassmorphism: { label: "Glassmorphism", desc: "轻玻璃、层级、浮层", scene: "现代 Dashboard、AI 面板" },
  dark_pro: { label: "Dark Pro", desc: "专业暗色、局部高亮", scene: "AI、开发者工具" },
  neo_brutalism: { label: "Neo-Brutalism", desc: "大胆、直接、高对比", scene: "创意、社区" },
  claymorphism: { label: "Claymorphism", desc: "柔和、亲和、圆润", scene: "教育、消费" },
  editorial: { label: "Editorial", desc: "内容叙事、强排版", scene: "媒体、品牌" },
  ai_native: { label: "AI-native", desc: "意图驱动、模块化、上下文感知", scene: "AI 工作台" },
  data_dense: { label: "Data-dense", desc: "信息效率、异常优先", scene: "BI、监控、运营" },
  mobile_first: { label: "Mobile-first", desc: "触控、底部操作、手势反馈", scene: "移动 Web、H5" },
} as const;
export type StylePresetId = keyof typeof STYLE_DIRECTION_PRESETS;
export const STYLE_DIRECTION_PRESET_IDS = Object.keys(STYLE_DIRECTION_PRESETS) as StylePresetId[];

export const designTokenOverridesSchema = z.object({
  /** 覆盖到 IR theme.tokens 的键值;键必须属于 ThemeTokens */
  tokens: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
});
export type DesignTokenOverrides = z.infer<typeof designTokenOverridesSchema>;

const layoutPreferencesSchema = z.object({
  density: z.enum(["compact", "comfortable", "spacious"]).default("comfortable"),
  grid: z.string().default("12-col"),
  cardStyle: z.enum(["flat", "bordered", "elevated", "glass", "neo-brutal", "clay"]).default("bordered"),
  cornerRadius: z.enum(["none", "small", "medium", "large", "pill"]).default("medium"),
  spacingScale: z.enum(["tight", "base", "loose"]).default("base"),
  typographyScale: z.string().default("1.25 modular"),
});
const motionPreferencesSchema = z.object({
  level: z.enum(["none", "subtle", "moderate", "expressive"]).default("subtle"),
  durationMs: z.number().int().default(150),
  easing: z.string().default("ease-out"),
  reducedMotionFallback: z.string().default("disable-transitions"),
});
const accessibilityGuardrailsSchema = z.object({
  minimumContrast: z.enum(["AA", "AAA"]).default("AA"),
  focusVisible: z.literal(true).default(true),
  colorNotOnlyIndicator: z.literal(true).default(true),
  minTouchTargetPx: z.number().int().default(44),
});

export const styleDirectionSchema = z.object({
  styleDirectionId: z.string().min(1),
  source: styleSourceSchema,
  presetIds: z.array(z.string()).default([]),
  customDescription: z.string().optional(),
  referenceInputs: z
    .array(
      z.object({
        type: z.enum(["image", "url", "tokens", "text", "brand"]),
        value: z.string(),
        note: z.string().optional(),
      }),
    )
    .default([]),
  /** 目标 UI 库 Adapter id(见 style.ts UILibraryAdapter) */
  uiLibraryId: z.string().default("shadcn-tailwind"),
  designPhilosophy: z.array(z.string()).default([]),
  /** 视觉关键词,不超过 8 个 */
  visualKeywords: z.array(z.string()).max(8).default([]),
  tokenOverrides: designTokenOverridesSchema.default(() => designTokenOverridesSchema.parse({})),
  layoutPreferences: layoutPreferencesSchema.default(() => layoutPreferencesSchema.parse({})),
  motionPreferences: motionPreferencesSchema.default(() => motionPreferencesSchema.parse({})),
  accessibilityGuardrails: accessibilityGuardrailsSchema.default(() => accessibilityGuardrailsSchema.parse({})),
  forbiddenPatterns: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0.8),
  assumptions: z.array(z.string()).default([]),
});
export type StyleDirection = z.infer<typeof styleDirectionSchema>;

// ---------------------------------------------------------------------------
// UI Library Adapter(文档 §23.3)
// ---------------------------------------------------------------------------

export const uiLibraryAdapterSchema = z.object({
  adapterId: z.string().min(1),
  displayName: z.string().min(1),
  framework: z.enum(["react", "vue", "web-components"]),
  styling: z.enum(["tailwind", "css", "css-in-js", "panda", "tokens"]),
  status: z.enum(["stable", "beta", "experimental"]),
  /** Catalog 组件类型 → 适配器实现说明(渲染预设/导出模板的映射依据) */
  componentMap: z.record(z.string(), z.string()).default({}),
  tokenMap: z.record(z.string(), z.string()).default({}),
  knownLimitations: z.array(z.string()).default([]),
  /** 渲染器预设 id(复用现有 registry:shadcn/antd/element/custom) */
  rendererPreset: z.enum(["shadcn", "antd", "element", "custom"]),
});
export type UILibraryAdapter = z.infer<typeof uiLibraryAdapterSchema>;

/** v1 注册表:只放已验证的适配器;工作台自身编辑器永远使用 shadcn/ui */
export const UILIBRARY_ADAPTERS: Record<string, UILibraryAdapter> = {
  "shadcn-tailwind": {
    adapterId: "shadcn-tailwind",
    displayName: "shadcn/ui + Tailwind",
    framework: "react",
    styling: "tailwind",
    status: "stable",
    componentMap: {},
    tokenMap: {},
    rendererPreset: "shadcn",
    knownLimitations: ["复杂表格组件依赖组合实现"],
  },
  "ant-design": {
    adapterId: "ant-design",
    displayName: "Ant Design",
    framework: "react",
    styling: "tokens",
    status: "stable",
    componentMap: {},
    tokenMap: {},
    rendererPreset: "antd",
    knownLimitations: ["风格较强,需要 Token 治理"],
  },
  element: {
    adapterId: "element",
    displayName: "Element UI",
    framework: "react",
    styling: "css",
    status: "experimental",
    componentMap: {},
    tokenMap: {},
    rendererPreset: "element",
    knownLimitations: ["仅作兼容保留,不进入 v1 承诺"],
  },
  mui: {
    adapterId: "mui",
    displayName: "Material UI",
    framework: "react",
    styling: "css-in-js",
    status: "beta",
    componentMap: {},
    tokenMap: {},
    rendererPreset: "shadcn", // 画布渲染回退 shadcn 预设(§23.3 降级说明)
    knownLimitations: ["画布渲染回退 shadcn 预设", "导出模板独立维护(beta)"],
  },
  mantine: {
    adapterId: "mantine",
    displayName: "Mantine",
    framework: "react",
    styling: "css",
    status: "beta",
    componentMap: {},
    tokenMap: {},
    rendererPreset: "shadcn",
    knownLimitations: ["画布渲染回退 shadcn 预设", "导出模板独立维护(beta)"],
  },
  vue3: {
    adapterId: "vue3",
    displayName: "Vue 3(experimental)",
    framework: "vue",
    styling: "tailwind",
    status: "experimental",
    componentMap: {},
    tokenMap: {},
    rendererPreset: "shadcn",
    knownLimitations: ["导出 Vue 3 SFC 静态工程", "画布渲染回退 shadcn 预设", "experimental:门禁跳过 tsc"],
  },
};

export function adapterOf(adapterId: string): UILibraryAdapter {
  return UILIBRARY_ADAPTERS[adapterId] ?? UILIBRARY_ADAPTERS["shadcn-tailwind"];
}

/** StyleDirection → IR 主题令牌合并(确定性,不经 LLM) */
export function applyStyleDirectionToTokens(base: ThemeTokens, sd: StyleDirection): ThemeTokens {
  const overrides = sd.tokenOverrides.tokens ?? {};
  const next: ThemeTokens = { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    if (k in base) {
      if (k === "radius") {
        const n = typeof v === "number" ? v : Number(v);
        if (Number.isFinite(n)) (next as Record<string, unknown>).radius = n;
      } else if (typeof v === "string") {
        (next as Record<string, unknown>)[k] = v;
      }
    }
  }
  // 布局偏好的圆角档位落到 tokens.radius(仅在未显式覆盖时)
  if (!("radius" in overrides)) {
    const rMap = { none: 0, small: 4, medium: 10, large: 16, pill: 24 } as const;
    (next as Record<string, unknown>).radius = rMap[sd.layoutPreferences.cornerRadius];
  }
  return next;
}
