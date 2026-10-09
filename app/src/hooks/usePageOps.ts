/**
 * 页面 ops 提交链路:本地快照 → applyOps → store 更新 → 双路持久化:
 *  1. pages.update(旧表兜底,兼容旧数据视图)
 *  2. workspace.commitPageOps(Design IR 主事实源,M7 起手动编辑与 AI 编辑同源)
 * 检查器、内联编辑等所有「手动编辑」共用,保证可撤销。
 * 跨页批量操作用 .multi(entries):单次 undo 快照,一次撤销回退整个批量操作。
 */
import { applyOps, type SurfaceOp } from "@contracts/a2ui";
import { useWorkspace, type PageState } from "@/stores/workspaceStore";
import { trpc } from "@/providers/trpc";
import { toast } from "sonner";

export interface PageOpsEntry {
  page: PageState;
  ops: SurfaceOp[];
}

export function usePageOps() {
  const snapshotForUndo = useWorkspace((s) => s.snapshotForUndo);
  const updatePageLocal = useWorkspace((s) => s.updatePageLocal);
  const updateMut = trpc.pages.update.useMutation({
    onError: () => toast.error("保存失败,请重试"),
  });
  const commitOpsMut = trpc.workspace.commitPageOps.useMutation({
    onError: (e) => toast.error(`IR 保存失败:${e.message.slice(0, 100)}`),
  });

  const submit = (entries: PageOpsEntry[]) => {
    if (!entries.length) return;
    snapshotForUndo();
    for (const { page, ops } of entries) {
      const next = applyOps(page.surface, ops);
      updatePageLocal(page.id, { surface: next });
      updateMut.mutate({ id: page.id, projectId: page.projectId, surface: next });
      // M7:同批 ops 同步落 Design IR(主事实源;baseRevision 服务端读 head)
      if (page.surfaceId) {
        commitOpsMut.mutate({
          projectId: page.projectId,
          surfaceId: page.surfaceId,
          ops: ops as never,
        });
      }
    }
  };

  return Object.assign(
    (page: PageState, ops: SurfaceOp[]) => submit([{ page, ops }]),
    { multi: submit },
  );
}
