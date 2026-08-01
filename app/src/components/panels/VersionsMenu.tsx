/**
 * 顶栏「版本」菜单:手动存档 / 版本列表 / 与当前状态对比(diff)/ 恢复 / 删除。
 * 恢复成功后直接拉取最新项目数据重建 store(initProject 会清撤销栈与选中态)。
 */
import { useEffect, useRef, useState } from "react";
import { GitBranch, GitCompareArrows, Loader2, Redo2, Save, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/providers/trpc";
import { useWorkspace } from "@/stores/workspaceStore";
import { diffPages, type PageDiffEntry } from "@/lib/pageDiff";
import type { PresetId } from "@contracts/a2ui";

const STATUS_STYLE: Record<PageDiffEntry["status"], { label: string; cls: string }> = {
  added: { label: "新增", cls: "bg-emerald-50 text-emerald-600" },
  removed: { label: "删除", cls: "bg-red-50 text-red-500" },
  modified: { label: "修改", cls: "bg-amber-50 text-amber-600" },
  same: { label: "无变化", cls: "bg-neutral-100 text-neutral-400" },
};

const fmtTime = (t: string | Date) =>
  new Date(t).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function VersionsMenu() {
  const projectId = useWorkspace((s) => s.projectId);
  const pages = useWorkspace((s) => s.pages);
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [diffView, setDiffView] = useState<{ label: string; entries: PageDiffEntry[] } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const utils = trpc.useUtils();
  const listQ = trpc.versions.list.useQuery(
    { projectId: projectId ?? 0 },
    { enabled: open && !!projectId },
  );
  const saveMut = trpc.versions.save.useMutation({
    onSuccess: () => {
      utils.versions.list.invalidate();
      setLabel("");
      toast.success("版本已保存");
    },
    onError: () => toast.error("保存失败,请重试"),
  });
  const restoreMut = trpc.versions.restore.useMutation({
    onSuccess: async (_r, vars) => {
      try {
        const d = await utils.projects.get.fetch({ id: vars.projectId });
        if (d) {
          useWorkspace.getState().initProject({
            id: d.id,
            name: d.name,
            preset: d.preset as PresetId,
            pages: d.pages.map((p) => ({
              id: p.id, projectId: p.projectId, title: p.title,
              device: p.device as never, surface: p.surface,
              posX: p.posX, posY: p.posY, width: p.width, height: p.height,
            })),
          });
        }
        setOpen(false);
        setDiffView(null);
        toast.success("已恢复到该版本");
      } catch {
        toast.error("恢复后刷新失败,请重新打开项目");
      }
    },
    onError: () => toast.error("恢复失败,请重试"),
  });
  const removeMut = trpc.versions.remove.useMutation({
    onSuccess: () => utils.versions.list.invalidate(),
  });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const doSave = () => {
    if (!projectId) return;
    saveMut.mutate({ projectId, label: label.trim() || `手动存档 ${fmtTime(new Date())}` });
  };

  const doDiff = async (v: { id: number; label: string }) => {
    if (!projectId) return;
    try {
      const snap = await utils.versions.get.fetch({ id: v.id, projectId });
      setDiffView({ label: v.label, entries: diffPages(snap.pages, pages) });
    } catch {
      toast.error("读取版本快照失败");
    }
  };

  const doRestore = (v: { id: number; label: string }) => {
    if (!projectId) return;
    if (!window.confirm(`恢复到版本「${v.label}」?\n当前状态会先自动保存为「回滚前自动快照」。`)) return;
    restoreMut.mutate({ id: v.id, projectId });
  };

  const changedCount = diffView?.entries.filter((e) => e.status !== "same").length ?? 0;

  return (
    <div className="relative" ref={menuRef}>
      <button
        title="版本历史"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-700">
        <GitBranch size={14} />
        版本
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-80 rounded-xl border border-neutral-200 bg-white p-1.5 shadow-xl">
          {/* 保存当前版本 */}
          <div className="flex items-center gap-1.5 p-1">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") doSave(); }}
              placeholder="版本说明(可选)"
              className="min-w-0 flex-1 rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400"
            />
            <button
              onClick={doSave}
              disabled={saveMut.isPending}
              className="flex shrink-0 items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50">
              {saveMut.isPending ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              存档
            </button>
          </div>

          <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-neutral-400">历史版本</div>
          {listQ.isPending && <div className="px-2 py-3 text-xs text-neutral-400">加载中…</div>}
          {listQ.data?.length === 0 && <div className="px-2 py-3 text-xs text-neutral-400">还没有版本记录</div>}
          <div className="max-h-72 overflow-y-auto">
            {listQ.data?.map((v) => (
              <div key={v.id} className="flex items-center gap-0.5 rounded-lg px-2 py-1.5 transition hover:bg-neutral-50">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-neutral-700">{v.label}</div>
                  <div className="text-[10px] text-neutral-400">{fmtTime(v.createdAt)}</div>
                </div>
                <button title="与当前状态对比" onClick={() => doDiff(v)}
                  className="rounded-md p-1.5 text-neutral-300 transition hover:bg-white hover:text-indigo-500">
                  <GitCompareArrows size={13} />
                </button>
                <button title="恢复到此版本" onClick={() => doRestore(v)} disabled={restoreMut.isPending}
                  className="rounded-md p-1.5 text-neutral-300 transition hover:bg-white hover:text-emerald-600 disabled:opacity-50">
                  <Redo2 size={13} />
                </button>
                <button title="删除版本" onClick={() => removeMut.mutate({ id: v.id, projectId: projectId! })}
                  disabled={removeMut.isPending}
                  className="rounded-md p-1.5 text-neutral-300 transition hover:bg-white hover:text-red-500 disabled:opacity-50">
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* diff 对比弹窗 */}
      {diffView && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={() => setDiffView(null)}>
          <div className="flex max-h-[80vh] w-[520px] flex-col rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between p-5 pb-3">
              <div>
                <h3 className="text-sm font-bold">与版本「{diffView.label}」对比</h3>
                <p className="mt-0.5 text-xs text-neutral-400">
                  {changedCount ? `${changedCount} 个页面有变化(版本 → 当前)` : "两个状态完全一致"}
                </p>
              </div>
              <button onClick={() => setDiffView(null)} className="rounded-lg p-1 text-neutral-400 hover:bg-neutral-100">
                <X size={15} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
              {diffView.entries.map((e) => {
                const st = STATUS_STYLE[e.status];
                return (
                  <div key={e.pageId} className="border-t border-neutral-100 py-2.5 first:border-t-0">
                    <div className="flex items-center gap-2">
                      <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${st.cls}`}>{st.label}</span>
                      <span className="truncate text-xs font-medium text-neutral-700">{e.title}</span>
                      {e.titleChanged && (
                        <span className="truncate text-[10px] text-neutral-400">「{e.titleChanged.from}」→「{e.titleChanged.to}」</span>
                      )}
                    </div>
                    {e.diff && (
                      <ul className="mt-1.5 flex flex-col gap-1 pl-1 text-[11px] text-neutral-500">
                        {!!e.diff.tokensChanged.length && (
                          <li>主题令牌变化:{e.diff.tokensChanged.join("、")}</li>
                        )}
                        {e.diff.added.map((c) => (
                          <li key={`a${c.aid}`} className="text-emerald-600">+ {c.type} <span className="text-neutral-300">#{c.aid}</span></li>
                        ))}
                        {e.diff.removed.map((c) => (
                          <li key={`r${c.aid}`} className="text-red-400">− {c.type} <span className="text-neutral-300">#{c.aid}</span></li>
                        ))}
                        {e.diff.changed.map((c) => (
                          <li key={`c${c.aid}`} className="text-amber-600">~ {c.type} <span className="text-neutral-300">#{c.aid}</span>({c.keys.join("、")})</li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
