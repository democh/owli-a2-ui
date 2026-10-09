import type { RuntimeTemplate, MappedComponent } from "./runtime";

/**
 * shadcn-ui 运行时模板(M5-2):生成 src/ui/kit.tsx 组件包装层
 * (Tailwind 实现的 Card/Button/Input/... 语义组件),页面 import 真实组件,
 * 视觉与画布一致(同源 Tailwind 类),零第三方运行时依赖。
 */

const div = (cls: string): MappedComponent => ({ comp: "div", className: cls });

/** kit.tsx:语义组件包装层(生成到导出工程 src/ui/kit.tsx) */
export const SHADCN_UI_KIT = `import type { ReactNode } from "react";

/** shadcn 风格语义组件包装层(A2UI codegen 运行时模板;Tailwind 实现,零第三方依赖) */

export function Card({ title, children, className = "" }: { title?: string; children?: ReactNode; className?: string }) {
  return (
    <div className={\`rounded-xl border bg-white p-4 shadow-sm \${className}\`}>
      {title ? <div className="mb-2 font-semibold tracking-tight">{title}</div> : null}
      {children}
    </div>
  );
}

export function Button({ type = "default", children, className = "" }: { type?: "primary" | "default" | "link"; children?: ReactNode; className?: string }) {
  const cls =
    type === "primary"
      ? "bg-gray-900 text-white hover:bg-gray-800"
      : type === "link"
        ? "text-blue-600 underline-offset-2 hover:underline"
        : "border hover:bg-gray-50";
  return <button className={\`rounded-lg px-4 py-2 text-sm font-medium transition \${cls} \${className}\`}>{children}</button>;
}

export function Input({ placeholder, className = "" }: { placeholder?: string; className?: string }) {
  return <input type="text" placeholder={placeholder} className={\`w-full rounded-lg border px-3 py-2 text-sm outline-none \${className}\`} />;
}

export function TextArea({ placeholder, className = "" }: { placeholder?: string; className?: string }) {
  return <textarea placeholder={placeholder} className={\`w-full rounded-lg border px-3 py-2 text-sm outline-none \${className}\`} />;
}

export function Badge({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return <span className={\`inline-block rounded-full bg-gray-100 px-2 py-0.5 text-xs \${className}\`}>{children}</span>;
}

export function Alert({ type = "info", children, className = "" }: { type?: "info" | "error"; children?: ReactNode; className?: string }) {
  return (
    <div className={\`rounded-lg border p-3 text-sm \${type === "error" ? "border-red-200 bg-red-50 text-red-700" : "border-blue-200 bg-blue-50 text-blue-700"} \${className}\`}>
      {children}
    </div>
  );
}

export function Progress({ percent = 0, className = "" }: { percent?: number; className?: string }) {
  return <progress value={percent} max={100} className={\`w-full \${className}\`} />;
}

export function Switch({ className = "" }: { className?: string }) {
  return <button className={\`h-5 w-9 rounded-full bg-gray-300 \${className}\`} />;
}

export function Checkbox({ className = "" }: { className?: string }) {
  return <input type="checkbox" className={\`size-4 rounded border \${className}\`} />;
}

export function Avatar({ src, className = "" }: { src?: string; className?: string }) {
  return src ? (
    <img src={src} alt="" className={\`size-8 rounded-full object-cover \${className}\`} />
  ) : (
    <span className={\`inline-block size-8 rounded-full bg-gray-200 \${className}\`} />
  );
}

export function Image({ src, alt = "", className = "rounded-lg object-cover" }: { src?: string; alt?: string; className?: string }) {
  return <img src={src} alt={alt} className={className} />;
}

export function Rate({ className = "text-amber-400" }: { className?: string }) {
  return <div className={className}>★★★★★</div>;
}

export function Divider({ className = "my-6 border-gray-200" }: { className?: string }) {
  return <hr className={className} />;
}

export function Empty({ children, className = "py-12 text-center text-sm text-gray-400" }: { children?: ReactNode; className?: string }) {
  return <div className={className}>{children ?? "暂无内容"}</div>;
}

export function Statistic({ title, value, className = "rounded-xl border p-4" }: { title?: string; value?: number | string; className?: string }) {
  return (
    <div className={className}>
      <div className="text-xs text-gray-500">{title}</div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
`;

export const shadcnUiTemplate: RuntimeTemplate = {
  id: "shadcn-ui",
  templateFiles: [{ path: "src/ui/kit.tsx", content: SHADCN_UI_KIT }],
  importSource: "./ui/kit",
  mapComponent(type, p): MappedComponent | undefined {
    switch (type) {
      case "Card":
        return { comp: "Card", importName: "Card", props: { title: p.title } };
      case "Button":
        return { comp: "Button", importName: "Button", props: { type: p.variant === "outline" ? "default" : "primary" } };
      case "Input":
        return { comp: "Input", importName: "Input", props: { placeholder: p.placeholder }, selfClose: true };
      case "Textarea":
        return { comp: "TextArea", importName: "TextArea", props: { placeholder: p.placeholder } };
      case "Title":
        return { comp: "h2", className: "text-2xl font-semibold tracking-tight" };
      case "Text":
        return { comp: "p", className: "text-sm leading-relaxed text-gray-600" };
      case "Image":
        return { comp: "Image", importName: "Image", props: { src: p.src, alt: p.alt ?? "" }, selfClose: true };
      case "Avatar":
        return { comp: "Avatar", importName: "Avatar", props: { src: p.src }, selfClose: true };
      case "Badge":
      case "Tag":
        return { comp: "Badge", importName: "Badge" };
      case "Alert":
        return { comp: "Alert", importName: "Alert", props: { type: p.variant === "error" ? "error" : "info" } };
      case "Progress":
        return { comp: "Progress", importName: "Progress", props: { percent: Number(p.percent ?? 0) }, selfClose: true };
      case "Switch":
        return { comp: "Switch", importName: "Switch", selfClose: true };
      case "Checkbox":
        return { comp: "Checkbox", importName: "Checkbox", selfClose: true };
      case "Rating":
        return { comp: "Rate", importName: "Rate", selfClose: true };
      case "Divider":
        return { comp: "Divider", importName: "Divider", selfClose: true };
      case "Empty":
        return { comp: "Empty", importName: "Empty" };
      case "Statistic":
        return { comp: "Statistic", importName: "Statistic", props: { title: p.title, value: Number(p.value ?? 0) } };
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
        return undefined;
    }
  },
};
