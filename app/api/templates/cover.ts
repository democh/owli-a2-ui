import type { IRDocument, IRSurface } from "@contracts/design-ir";
import type { SurfaceDoc } from "@contracts/a2ui";
import { buildHtmlSite } from "../export/site";

/**
 * M7 模板封面生成:首个 surface → 静态 HTML(复用站点导出管线)。
 * 保存模板时生成一次;cover 端点对无封面的老模板按需懒生成。
 */
export function generateTemplateCoverHtml(
  templateName: string,
  doc: Pick<IRDocument, "theme" | "surfaces">,
): string | null {
  const first = Object.values(doc.surfaces)[0] as IRSurface | undefined;
  if (!first) return null;
  const coverDoc: SurfaceDoc = {
    version: "1.0",
    page: { id: first.id, title: first.title, device: "desktop" },
    theme: doc.theme,
    components: first.components as SurfaceDoc["components"],
    root: first.root,
  };
  const files = buildHtmlSite(templateName, [{ title: first.title, surface: coverDoc }]);
  return Object.entries(files).find(([k]) => k.endsWith(".html"))?.[1] ?? null;
}
