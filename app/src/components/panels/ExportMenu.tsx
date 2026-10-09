/**
 * 顶栏「导出 React 工程」菜单(M5-2 适配器选择 + M5-1 完整构建门禁)
 * 选择 UI 库适配器后提交异步构建(tsc + vite build),轮询通过即自动下载 zip。
 */
import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/providers/trpc";
import { ADAPTER_COMPATIBILITY, type AdapterCompat } from "@contracts/adapter-matrix";

const ADAPTERS = [
  { id: "shadcn-tailwind", label: "静态 Tailwind", desc: "语义映射 · 零依赖 · 默认", matrixKey: "shadcn" as const },
  { id: "antd", label: "Ant Design", desc: "真实 antd 组件 import", matrixKey: "antd" as const },
  { id: "shadcn-ui", label: "shadcn 组件包", desc: "本地 kit 包装层 · Tailwind 实现", matrixKey: "shadcn" as const },
  { id: "mui", label: "Material UI(beta)", desc: "beta:导出沿用静态模板,MUI 运行时模板迭代中", matrixKey: "mui" as const },
  { id: "mantine", label: "Mantine(beta)", desc: "beta:导出沿用静态模板,Mantine 运行时模板迭代中", matrixKey: "mantine" as const },
  { id: "vue3", label: "Vue 3(experimental)", desc: "Vue 3 SFC 静态工程 · 门禁跳过 tsc", matrixKey: "vue3" as const },
] as const;

/** §23.3 兼容矩阵 tooltip:专属实现数量 / 兜底组件 / 已知限制 */
function matrixTip(c: AdapterCompat): string {
  const fb = c.fallback.length ? ` · 兜底:${c.fallback.slice(0, 4).join("/")}${c.fallback.length > 4 ? "…" : ""}` : "";
  return `专属实现 ${c.native.length} 个组件${fb} · ${c.limitations.join(";")}`;
}

type AdapterId = (typeof ADAPTERS)[number]["id"];

export function ExportMenu({ projectId, baseRevision, projectName }: { projectId: number; baseRevision: number; projectName: string }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buildMut = trpc.exports.build.useMutation();
  const tutils = trpc.useUtils();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const pollBuild = async (jobId: string, onTick: (msg: string) => void): Promise<string | null> => {
    for (let i = 0; i < 180; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const s = await tutils.exports.buildStatus.fetch({ jobId });
      onTick(
        s.status === "running"
          ? `构建门禁进行中:${s.steps.map((st) => `${st.step}${st.ok ? "✓" : "…"}`).join(" ")}`
          : `构建门禁:${s.status}`,
      );
      if (s.status === "passed") return s.exportId ?? null;
      if (s.status === "failed") {
        const firstErr = s.issues.find((i2) => i2.severity === "error");
        throw new Error(`构建门禁失败:${firstErr?.message.slice(0, 200) || s.error || "未知原因"}`);
      }
    }
    throw new Error("构建门禁超时(>6 分钟),请稍后在导出历史中查看结果");
  };

  const doExport = async (adapterId: AdapterId) => {
    setOpen(false);
    const toastId = toast.loading("已提交完整构建门禁…");
    try {
      const { jobId } = await buildMut.mutateAsync({ projectId, baseRevision, projectName, adapterId });
      const exportId = await pollBuild(jobId, (msg) => toast.loading(msg, { id: toastId }));
      if (!exportId) throw new Error("门禁通过但产物未登记");
      toast.success("完整构建门禁通过,开始下载", { id: toastId });
      window.open(`/api/exports/${exportId}/download`, "_blank");
    } catch (err) {
      toast.error((err as Error).message.slice(0, 160), { id: toastId });
    }
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        title="导出 React 工程(完整构建门禁:tsc + vite build)"
        onClick={() => setOpen((v) => !v)}
        className="rounded-lg p-2 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-600">
        <Download size={15} />
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-30 w-64 rounded-xl border border-neutral-200 bg-white p-1.5 shadow-xl">
          <div className="px-2.5 py-1.5 text-[10px] font-medium text-neutral-400">选择 UI 库适配器</div>
          {ADAPTERS.map((a) => (
            <button
              key={a.id}
              onClick={() => void doExport(a.id)}
              title={matrixTip(ADAPTER_COMPATIBILITY[a.matrixKey])}
              className="flex w-full flex-col items-start rounded-lg px-2.5 py-2 text-left transition hover:bg-neutral-50">
              <span className="text-xs font-medium text-neutral-700">{a.label}</span>
              <span className="text-[10px] text-neutral-400">{a.desc}</span>
              <span className="mt-0.5 text-[10px] text-neutral-300">
                兼容矩阵:{ADAPTER_COMPATIBILITY[a.matrixKey].native.length} 组件专属
                {ADAPTER_COMPATIBILITY[a.matrixKey].fallback.length ? ` · ${ADAPTER_COMPATIBILITY[a.matrixKey].fallback.length} 兜底` : ""}
              </span>
            </button>
          ))}
          <div className="border-t border-neutral-100 px-2.5 py-1.5 text-[10px] leading-relaxed text-neutral-400">
            所有适配器均先经完整构建门禁(tsc --noEmit → vite build),通过后自动登记并下载。
          </div>
        </div>
      )}
    </div>
  );
}
