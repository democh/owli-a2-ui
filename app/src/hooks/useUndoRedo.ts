/**
 * 撤销/重做(含数据库持久化),供顶栏与 Agent 面板内联操作共用
 * 快照包含页面数组与风格预设,撤销时一并恢复
 * 持久化走 batchUpdate 单事务批量接口,失败时明确提示(不再静默分叉)
 */
import { useCallback } from "react";
import { toast } from "sonner";
import { trpc } from "@/providers/trpc";
import { useWorkspace, type Snapshot } from "@/stores/workspaceStore";

export function useUndoRedo() {
  const batchUpdateMut = trpc.pages.batchUpdate.useMutation({
    onError: () => toast.error("撤销/重做保存失败:画布与数据库可能不一致,请刷新页面同步"),
  });
  const updateProjectMut = trpc.projects.update.useMutation({
    onError: () => toast.error("风格预设保存失败,请重试"),
  });

  const persistSnapshot = useCallback(
    (snap: Snapshot, prevPreset: string) => {
      const { projectId } = useWorkspace.getState();
      if (!projectId) return;
      // 负 id 是流式幻影画框,不落库
      const payload = snap.pages
        .filter((p) => p.id > 0)
        .map((p) => ({
          id: p.id, title: p.title, device: p.device,
          posX: p.posX, posY: p.posY, width: p.width, height: p.height,
          surface: p.surface,
        }));
      if (payload.length) batchUpdateMut.mutate({ projectId, pages: payload });
      if (snap.preset !== prevPreset) {
        updateProjectMut.mutate({ id: projectId, preset: snap.preset });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const doUndo = useCallback(() => {
    const before = useWorkspace.getState().preset;
    const prev = useWorkspace.getState().undo();
    if (prev) persistSnapshot(prev, before);
  }, [persistSnapshot]);

  const doRedo = useCallback(() => {
    const before = useWorkspace.getState().preset;
    const next = useWorkspace.getState().redo();
    if (next) persistSnapshot(next, before);
  }, [persistSnapshot]);

  const canUndo = useWorkspace((s) => s.past.length > 0);
  const canRedo = useWorkspace((s) => s.future.length > 0);

  return { doUndo, doRedo, canUndo, canRedo };
}
