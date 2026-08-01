/**
 * 顶栏「导出 / 部署」菜单
 * 导出:React / Vue / HTML 工程 zip;部署:一键发布静态站点 + 部署历史管理
 */
import { useEffect, useRef, useState } from "react";
import { Check, Copy, Download, ExternalLink, FileCode2, Globe, History, Loader2, Rocket, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/providers/trpc";
import { useWorkspace } from "@/stores/workspaceStore";

const EXPORT_TARGETS = [
  { id: "react-vite", label: "React 工程", desc: "Vite + React 19 + TS" },
  { id: "vue-vite", label: "Vue 工程", desc: "Vite + Vue 3" },
  { id: "html", label: "HTML 静态站", desc: "零依赖 · 直接部署" },
] as const;

export function PublishMenu() {
  const projectId = useWorkspace((s) => s.projectId);
  const [exportOpen, setExportOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deployOpen, setDeployOpen] = useState(false);
  const [slugInput, setSlugInput] = useState("");
  const [deployResult, setDeployResult] = useState<{ url: string; pageCount: number } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const utils = trpc.useUtils();
  const exportMut = trpc.publish.export.useMutation();
  const deployMut = trpc.publish.deploy.useMutation();
  const deploysQ = trpc.publish.deploys.useQuery(
    { projectId: projectId ?? 0 },
    { enabled: historyOpen && !!projectId },
  );
  const removeMut = trpc.publish.removeDeploy.useMutation({
    onSuccess: () => utils.publish.deploys.invalidate(),
  });

  useEffect(() => {
    if (!exportOpen && !historyOpen && !deployOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setExportOpen(false);
      setHistoryOpen(false);
      setDeployOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [exportOpen, historyOpen, deployOpen]);

  const doExport = (target: (typeof EXPORT_TARGETS)[number]["id"]) => {
    if (!projectId) return;
    setExportOpen(false);
    exportMut.mutate({ projectId, target }, {
      onSuccess: (r) => {
        const bin = atob(r.base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = r.filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      },
    });
  };

  const doDeploy = () => {
    if (!projectId) return;
    const slug = slugInput.trim() || undefined;
    deployMut.mutate({ projectId, slug }, {
      onSuccess: (r) => {
        setDeployResult({ url: r.url, pageCount: r.pageCount });
        setDeployOpen(false);
        setSlugInput("");
        utils.publish.deploys.invalidate();
      },
      onError: (e) => toast.error(e.message || "部署失败,请重试"),
    });
  };

  const fullUrl = deployResult ? `${window.location.origin}${deployResult.url}` : "";

  return (
    <div className="relative flex items-center gap-1" ref={menuRef}>
      {/* 导出 */}
      <button
        title="导出项目代码"
        onClick={() => setExportOpen(!exportOpen)}
        disabled={exportMut.isPending}
        className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-50">
        {exportMut.isPending ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
        导出
      </button>
      {exportOpen && (
        <div className="absolute right-0 top-full z-50 mt-1 w-56 rounded-xl border border-neutral-200 bg-white p-1.5 shadow-xl">
          {EXPORT_TARGETS.map((t) => (
            <button key={t.id}
              onClick={() => doExport(t.id)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-indigo-50">
              <FileCode2 size={15} className="shrink-0 text-indigo-400" />
              <span>
                <span className="block text-xs font-medium text-neutral-700">{t.label}</span>
                <span className="block text-[10px] text-neutral-400">{t.desc}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {/* 部署(可选自定义 URL 标识) */}
      <button
        title="一键部署为静态站点"
        onClick={() => setDeployOpen(!deployOpen)}
        disabled={deployMut.isPending}
        className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50">
        {deployMut.isPending ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />}
        {deployMut.isPending ? "部署中" : "部署"}
      </button>
      {deployOpen && !deployMut.isPending && (
        <div className="absolute right-0 top-full z-50 mt-1 w-64 rounded-xl border border-neutral-200 bg-white p-3 shadow-xl">
          <div className="text-xs font-medium text-neutral-700">部署为静态站点</div>
          <input
            autoFocus
            value={slugInput}
            onChange={(e) => setSlugInput(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
            onKeyDown={(e) => { if (e.key === "Enter") doDeploy(); }}
            placeholder="自定义标识(可选,如 landing)"
            className="mt-2 w-full rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400"
          />
          <div className="mt-1 text-[10px] text-neutral-400">留空自动生成;标识用于 URL:/deployed/…/标识/</div>
          <button
            onClick={doDeploy}
            className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-indigo-500">
            <Rocket size={13} /> 开始部署
          </button>
        </div>
      )}

      {/* 部署历史 */}
      <button
        title="部署历史"
        onClick={() => setHistoryOpen(!historyOpen)}
        className="flex items-center justify-center rounded-lg p-1.5 text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-700">
        <History size={14} />
      </button>
      {historyOpen && (
        <div className="absolute right-0 top-full z-50 mt-1 w-72 rounded-xl border border-neutral-200 bg-white p-1.5 shadow-xl">
          <div className="px-2 py-1.5 text-[10px] font-medium uppercase tracking-wide text-neutral-400">部署历史</div>
          {deploysQ.isPending && <div className="px-2 py-3 text-xs text-neutral-400">加载中…</div>}
          {deploysQ.data?.length === 0 && <div className="px-2 py-3 text-xs text-neutral-400">还没有部署记录</div>}
          <div className="max-h-64 overflow-y-auto">
            {deploysQ.data?.map((d) => (
              <div key={d.id} className="group flex items-center gap-1 rounded-lg px-2 py-1.5 transition hover:bg-neutral-50">
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium text-neutral-700">
                    {d.slug}
                    <span className="ml-1.5 text-[10px] font-normal text-neutral-400">{d.pageCount} 页</span>
                    {d.status === "failed" && <span className="ml-1.5 text-[10px] text-red-400">失败</span>}
                  </div>
                  <div className="text-[10px] text-neutral-400">{new Date(d.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</div>
                </div>
                {d.status !== "failed" && (
                  <>
                    <a href={d.url} target="_blank" rel="noreferrer" title="打开站点"
                      className="rounded-md p-1.5 text-neutral-300 transition hover:bg-white hover:text-indigo-500">
                      <ExternalLink size={13} />
                    </a>
                    <button
                      title="复制链接"
                      onClick={() => {
                        navigator.clipboard.writeText(`${window.location.origin}${d.url}`).catch(() => {});
                        setCopied(d.slug);
                        setTimeout(() => setCopied(null), 1500);
                      }}
                      className="rounded-md p-1.5 text-neutral-300 transition hover:bg-white hover:text-indigo-500">
                      {copied === d.slug ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}
                    </button>
                  </>
                )}
                <button
                  title="删除部署"
                  disabled={removeMut.isPending}
                  onClick={() => removeMut.mutate({ deployId: d.id })}
                  className="rounded-md p-1.5 text-neutral-300 transition hover:bg-white hover:text-red-500 disabled:opacity-50">
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 部署结果弹窗 */}
      {deployResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={() => setDeployResult(null)}>
          <div className="w-[440px] rounded-2xl bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2.5">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-500">
                  <Globe size={18} />
                </span>
                <div>
                  <h3 className="text-sm font-bold">部署成功</h3>
                  <p className="text-xs text-neutral-400">{deployResult.pageCount} 个页面已发布为静态站点</p>
                </div>
              </div>
              <button onClick={() => setDeployResult(null)} className="rounded-lg p-1 text-neutral-400 hover:bg-neutral-100">
                <X size={15} />
              </button>
            </div>
            <div className="mt-4 flex items-center gap-2 rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2.5">
              <span className="min-w-0 flex-1 truncate text-xs text-neutral-600">{fullUrl}</span>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(fullUrl).catch(() => {});
                  setCopied("modal");
                  setTimeout(() => setCopied(null), 1500);
                }}
                className="shrink-0 rounded-lg p-1.5 text-neutral-400 transition hover:bg-white hover:text-indigo-600">
                {copied === "modal" ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}
              </button>
            </div>
            <div className="mt-4 flex gap-2">
              <a href={deployResult.url} target="_blank" rel="noreferrer"
                className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500">
                <ExternalLink size={14} /> 打开站点
              </a>
              <button onClick={() => setDeployResult(null)}
                className="rounded-xl border border-neutral-200 px-4 py-2 text-sm text-neutral-500 transition hover:bg-neutral-50">
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
