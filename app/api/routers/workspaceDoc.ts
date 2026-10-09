import type { IRDocument, ThemeTokens } from "@contracts/design-ir";

/** 空白 IR 文档(workspace 初始化 / 兜底) */
export function emptyIRDocument(): IRDocument {
  const tokens: ThemeTokens = {
    primary: "#18181b", background: "#ffffff", surface: "#f4f4f5",
    text: "#09090b", mutedText: "#71717a", accent: "#2563eb", radius: 10, font: "",
  };
  return { revision: 0, theme: { preset: "shadcn", tokens }, surfaces: {}, dataModels: {}, componentDefs: {} };
}
