import type { RuntimeTemplate, MappedComponent } from "./runtime";

/**
 * antd 运行时模板(M5-2):真实 antd 组件 import + 映射渲染器。
 * 高频组件映射到 antd,布局/营销类组件退化 Tailwind 静态(视觉与画布一致),
 * 未映射类型由调用方统一 data-unknown 退化。
 */

const div = (cls: string): MappedComponent => ({ comp: "div", className: cls });

export const antdTemplate: RuntimeTemplate = {
  id: "antd",
  extraDependencies: { antd: "^6.5.2" },
  templateFiles: [],
  importSource: "antd",
  mapComponent(type, p): MappedComponent | undefined {
    const text = typeof p.text === "string" ? p.text : undefined;
    switch (type) {
      case "Card":
        return { comp: "Card", importName: "Card", props: { title: p.title, bordered: true } };
      case "Button": {
        const t = p.variant === "outline" ? "default" : "primary";
        return { comp: "Button", importName: "Button", props: { type: t } };
      }
      case "Input":
        return { comp: "Input", importName: "Input", props: { placeholder: p.placeholder }, selfClose: true };
      case "Textarea":
        return { comp: "Input.TextArea", importName: "Input", props: { placeholder: p.placeholder } };
      case "Title":
        return { comp: "Typography.Title", importName: "Typography", props: { level: Math.min(4, Number(p.level) || 2) } };
      case "Text":
        return { comp: "Typography.Text", importName: "Typography", props: { type: "secondary" } };
      case "Image":
        return { comp: "Image", importName: "Image", props: { src: p.src, alt: p.alt ?? "" }, selfClose: true };
      case "Avatar":
        return { comp: "Avatar", importName: "Avatar", props: { src: p.src, size: 32 }, selfClose: true };
      case "Badge":
      case "Tag":
        return { comp: "Tag", importName: "Tag", props: { color: p.variant === "error" ? "red" : "blue" } };
      case "Alert":
        return {
          comp: "Alert",
          importName: "Alert",
          props: { type: p.variant === "error" ? "error" : "info", message: text ?? "" },
          selfClose: true,
        };
      case "Progress":
        return { comp: "Progress", importName: "Progress", props: { percent: Number(p.percent ?? 0) }, selfClose: true };
      case "Switch":
        return { comp: "Switch", importName: "Switch", selfClose: true };
      case "Checkbox":
        return { comp: "Checkbox", importName: "Checkbox", props: { label: p.label }, selfClose: true };
      case "Rating":
        return { comp: "Rate", importName: "Rate", selfClose: true };
      case "Divider":
        return { comp: "Divider", importName: "Divider", selfClose: true };
      case "Statistic":
        return { comp: "Statistic", importName: "Statistic", props: { title: p.title, value: Number(p.value ?? 0) } };
      case "Empty":
        return { comp: "Empty", importName: "Empty", selfClose: true };
      // 布局类:静态 Tailwind 保持与画布一致的间距语义
      case "Section":
        return div("w-full px-6 py-10");
      case "Container":
        return div("mx-auto max-w-6xl");
      case "Row":
        return div("flex flex-wrap gap-4");
      case "Col":
        return div("flex-1 min-w-0");
      case "Grid":
        return div(`grid gap-4 ${p.cols ? `grid-cols-${p.cols}` : "grid-cols-3"}`);
      case "Navbar":
        return div("flex items-center justify-between border-b px-6 py-3");
      case "Footer":
        return div("border-t px-6 py-8 text-sm text-gray-500");
      case "Hero":
        return div("px-6 py-20 text-center");
      case "List":
        return div("divide-y");
      case "ListItem":
        return div("py-2");
      case "Table":
        return div("w-full text-left text-sm");
      case "Form":
      case "LoginForm":
        return div(type === "LoginForm" ? "mx-auto max-w-sm space-y-3 rounded-xl border p-6" : "space-y-3");
      case "CTASection":
        return div("rounded-2xl bg-gray-900 p-10 text-center text-white");
      default:
        return undefined; // 调用方继续静态 MAP 兜底
    }
  },
};
