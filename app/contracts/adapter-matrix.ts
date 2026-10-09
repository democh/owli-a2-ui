import { CATALOG_TYPES } from "./a2ui";

/**
 * UI Library Adapter 兼容矩阵(文档 §23.3 / M6)
 *
 * 以渲染器注册表实际覆盖为准:shadcn/antd 为专属实现全集;element 部分组件
 * 回退 shadcn 视觉;custom 完全复用 shadcn(token 驱动)。供 ExportMenu 提示、
 * ValidationPipeline adapter 层与导出模板选择消费。
 */

export interface AdapterCompat {
  /** 归一化后的预设 id(VALID_ADAPTER_PRESETS 同口径) */
  adapterId: "shadcn" | "antd" | "element" | "custom" | "mui" | "mantine" | "vue3";
  displayName: string;
  /** 专属实现渲染的组件 */
  native: string[];
  /** 回退 shadcn/token 渲染的组件(结果可用,但非该设计语言专属实现) */
  fallback: string[];
  limitations: string[];
}

const SHADCN_NATIVE = [...CATALOG_TYPES];

const ANTD_NATIVE = [
  "Navbar", "Hero", "Section", "Container", "Row", "Col", "Grid", "Card", "Footer", "Divider", "Tabs", "SidebarLayout",
  "Title", "Text", "Link", "Badge", "Tag",
  "Button", "Input", "Textarea", "Select", "Checkbox", "Switch", "SearchBar", "LoginForm", "Form",
  "Table", "List", "ListItem", "Avatar", "Statistic", "Progress", "Chart", "Timeline", "Rating", "Empty",
  "NavLinks", "Breadcrumb", "Pagination", "Steps", "TabBar",
  "Alert", "Skeleton",
  "Image", "Icon", "LogoCloud",
  "FeatureGrid", "PricingTable", "TestimonialCard", "StatsRow", "CTASection", "FAQ", "ProductCard",
];

const diff = (native: string[]) => CATALOG_TYPES.filter((t) => !native.includes(t));

export const ADAPTER_COMPATIBILITY: Record<AdapterCompat["adapterId"], AdapterCompat> = {
  shadcn: {
    adapterId: "shadcn",
    displayName: "shadcn/ui + Tailwind",
    native: SHADCN_NATIVE,
    fallback: [],
    limitations: ["代码复制模型,适合继续维护;主题由 token 变量驱动"],
  },
  antd: {
    adapterId: "antd",
    displayName: "Ant Design",
    native: ANTD_NATIVE,
    fallback: diff(ANTD_NATIVE),
    limitations: ["风格较强,需 Token 治理;antd 依赖约 1MB,导出工程含完整依赖"],
  },
  element: {
    adapterId: "element",
    displayName: "Element 视觉",
    native: [
      "Navbar", "Card", "SidebarLayout", "Tabs",
      "Button", "Input", "Textarea", "Select", "Checkbox", "Switch", "SearchBar",
      "Table", "Statistic",
      "Tag", "Badge", "Pagination", "Alert",
    ],
    fallback: diff([
      "Navbar", "Card", "SidebarLayout", "Tabs",
      "Button", "Input", "Textarea", "Select", "Checkbox", "Switch", "SearchBar",
      "Table", "Statistic",
      "Tag", "Badge", "Pagination", "Alert",
    ]),
    limitations: ["仅核心组件为 Element 视觉;其余回退 shadcn 实现(结果一致,视觉细节不同)"],
  },
  custom: {
    adapterId: "custom",
    displayName: "Custom(token 驱动)",
    native: [...CATALOG_TYPES],
    fallback: [],
    limitations: ["复用 shadcn 渲染并以主题 token 驱动,无专属组件实现"],
  },
  mui: {
    adapterId: "mui",
    displayName: "Material UI(beta)",
    native: [
      "Navbar", "Hero", "Section", "Container", "Row", "Col", "Grid", "Card", "Footer", "Divider", "Tabs",
      "Title", "Text", "Link", "Badge", "Tag",
      "Button", "Input", "Textarea", "Select", "Checkbox", "Switch",
      "Table", "List", "ListItem", "Avatar", "Statistic", "Progress", "Rating", "Empty",
      "Alert", "Skeleton", "Pagination",
    ],
    fallback: diff([
      "Navbar", "Hero", "Section", "Container", "Row", "Col", "Grid", "Card", "Footer", "Divider", "Tabs",
      "Title", "Text", "Link", "Badge", "Tag",
      "Button", "Input", "Textarea", "Select", "Checkbox", "Switch",
      "Table", "List", "ListItem", "Avatar", "Statistic", "Progress", "Rating", "Empty",
      "Alert", "Skeleton", "Pagination",
    ]),
    limitations: ["beta:画布渲染回退 shadcn 预设;导出沿用静态 Tailwind 模板,MUI 运行时模板独立迭代"],
  },
  mantine: {
    adapterId: "mantine",
    displayName: "Mantine(beta)",
    native: [
      "Navbar", "Section", "Container", "Row", "Col", "Grid", "Card", "Footer", "Divider", "Tabs",
      "Title", "Text", "Link", "Badge", "Tag",
      "Button", "Input", "Textarea", "Select", "Checkbox", "Switch", "SearchBar",
      "Table", "List", "ListItem", "Avatar", "Progress", "Empty",
      "Alert", "Skeleton", "Pagination", "Breadcrumb",
    ],
    fallback: diff([
      "Navbar", "Section", "Container", "Row", "Col", "Grid", "Card", "Footer", "Divider", "Tabs",
      "Title", "Text", "Link", "Badge", "Tag",
      "Button", "Input", "Textarea", "Select", "Checkbox", "Switch", "SearchBar",
      "Table", "List", "ListItem", "Avatar", "Progress", "Empty",
      "Alert", "Skeleton", "Pagination", "Breadcrumb",
    ]),
    limitations: ["beta:画布渲染回退 shadcn 预设;导出沿用静态 Tailwind 模板,Mantine 运行时模板独立迭代"],
  },
  vue3: {
    adapterId: "vue3",
    displayName: "Vue 3(experimental)",
    native: [...CATALOG_TYPES],
    fallback: [],
    limitations: ["experimental:导出 Vue 3 SFC 静态工程(零 UI 库运行时);画布渲染回退 shadcn;门禁跳过 tsc"],
  },
};

/** uiLibraryId(如 shadcn-tailwind / ant-design)→ 预设 key */
export function normalizeAdapterId(uiLibraryId?: string): AdapterCompat["adapterId"] | null {
  if (!uiLibraryId) return null;
  const preset = uiLibraryId.replace("-tailwind", "").replace("ant-design", "antd");
  if (preset === "shadcn" || preset === "antd" || preset === "element" || preset === "custom" || preset === "mui" || preset === "mantine" || preset === "vue3") {
    return preset;
  }
  return null;
}

/** 取适配器兼容信息;未注册回退 shadcn */
export function adapterCompatFor(uiLibraryId?: string): AdapterCompat {
  const key = normalizeAdapterId(uiLibraryId) ?? "shadcn";
  return ADAPTER_COMPATIBILITY[key];
}
