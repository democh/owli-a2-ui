/**
 * 无限画布舞台
 * InfiniteViewer(平移/缩放) + Moveable(拖拽/缩放/吸附) + Selecto(框选)
 * 拖拽过程只写 DOM transform,松手才同步 store + 持久化,保证 60fps
 *
 * 交互:
 * - 滚轮平移 · Ctrl/⌘+滚轮以指针为中心缩放(触控板双指捏合同理)
 * - 左键拖空白平移 · Shift+左键框选 · 双击 Frame 标题栏聚焦适配
 * - 快捷键:+/- 缩放 · 0 恢复 100% · 1 适应全部 · Delete 删除选中 · 方向键微调(Shift×10)
 * - 视口(缩放+位置)按项目持久化,重开自动恢复
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import InfiniteViewer from "react-infinite-viewer";
import Moveable from "react-moveable";
import Selecto from "react-selecto";
import { useWorkspace } from "@/stores/workspaceStore";
import { trpc } from "@/providers/trpc";
import { FrameView } from "./FrameView";

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 2.5;

export function CanvasStage() {
  const viewerRef = useRef<InfiniteViewer>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewportEl, setViewportEl] = useState<HTMLElement | null>(null);
  const [targets, setTargets] = useState<HTMLElement[]>([]);

  const pages = useWorkspace((s) => s.pages);
  const draft = useWorkspace((s) => s.draft);
  const projectId = useWorkspace((s) => s.projectId);
  const selectedPageIds = useWorkspace((s) => s.selectedPageIds);
  const setSelectedPages = useWorkspace((s) => s.setSelectedPages);
  const setSelectedElements = useWorkspace((s) => s.setSelectedElements);
  const setZoom = useWorkspace((s) => s.setZoom);
  const zoom = useWorkspace((s) => s.zoom);
  const updatePageLocal = useWorkspace((s) => s.updatePageLocal);

  const persistMut = trpc.pages.update.useMutation();
  const removeMut = trpc.pages.remove.useMutation();
  const persistTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  // 空白处 mousedown 坐标(用于区分"单击清空选择"与"拖拽平移")
  const emptyDownRef = useRef<{ x: number; y: number } | null>(null);
  // 视口持久化去抖
  const viewportSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 标记本次会话是否已恢复过视口(恢复后不再自动居中首页)
  const restoredViewportRef = useRef(false);

  const persistPage = useCallback((id: number, patch: Record<string, number>) => {
    const timers = persistTimers.current;
    if (timers.has(id)) clearTimeout(timers.get(id)!);
    timers.set(id, setTimeout(() => {
      const pid = useWorkspace.getState().projectId;
      if (pid) persistMut.mutate({ id, projectId: pid, ...patch });
      timers.delete(id);
    }, 600));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 卸载时清理全部计时器
  useEffect(() => {
    const timers = persistTimers.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
      if (viewportSaveTimer.current) clearTimeout(viewportSaveTimer.current);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // 视口操作
  // ---------------------------------------------------------------------------
  /** 以视口内某点(容器坐标)为中心缩放 */
  const zoomAt = useCallback((nextZoom: number, px?: number, py?: number) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
    const old = viewer.getZoom();
    const mx = px ?? viewer.getContainerWidth() / 2;
    const my = py ?? viewer.getContainerHeight() / 2;
    // 指针下的内容坐标在缩放前后保持不动
    const cx = (viewer.getScrollLeft() + mx) / old;
    const cy = (viewer.getScrollTop() + my) / old;
    viewer.setZoom(z);
    viewer.scrollTo(cx * z - mx, cy * z - my);
    setZoom(z);
  }, [setZoom]);

  /** 将内容坐标点居中到视口(scrollTo 的坐标是未缩放内容坐标,语义为"置于视口左上") */
  const centerOn = useCallback((cx: number, cy: number, z?: number, duration = 0) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const zoom = z ?? viewer.getZoom();
    viewer.scrollTo(
      cx - viewer.getContainerWidth() / 2 / zoom,
      cy - viewer.getContainerHeight() / 2 / zoom,
      { duration },
    );
  }, []);

  /** 适应全部页面 */
  const fitAll = useCallback((duration = 200) => {
    const v = viewerRef.current;
    const ps = useWorkspace.getState().pages;
    if (!v || !ps.length) return;
    const x1 = Math.min(...ps.map((p) => p.posX)) - 120;
    const y1 = Math.min(...ps.map((p) => p.posY)) - 120;
    const x2 = Math.max(...ps.map((p) => p.posX + p.width)) + 120;
    const y2 = Math.max(...ps.map((p) => p.posY + p.height + 34)) + 120;
    const z = Math.max(MIN_ZOOM, Math.min(v.getContainerWidth() / (x2 - x1), v.getContainerHeight() / (y2 - y1), 1));
    v.setZoom(z);
    setZoom(z);
    centerOn((x1 + x2) / 2, (y1 + y2) / 2, z, duration);
  }, [centerOn, setZoom]);

  /** 聚焦并适配单个页面 */
  const focusPage = useCallback((id: number, duration = 300) => {
    const page = useWorkspace.getState().pages.find((p) => p.id === id);
    const viewer = viewerRef.current;
    if (!page || !viewer) return;
    const fit = Math.min(
      viewer.getContainerWidth() / (page.width + 200),
      viewer.getContainerHeight() / (page.height + 200),
      1,
    );
    const z = Math.max(0.15, fit * 0.92);
    viewer.setZoom(z);
    setZoom(z);
    centerOn(page.posX + page.width / 2, page.posY + (page.height + 34) / 2, z, duration);
    setSelectedPages([id]);
  }, [centerOn, setSelectedPages, setZoom]);

  // ---------------------------------------------------------------------------
  // 视口持久化(按项目)
  // ---------------------------------------------------------------------------
  const viewportKey = projectId ? `a2.viewport.${projectId}` : null;
  const scheduleViewportSave = useCallback(() => {
    if (!viewportKey) return;
    if (viewportSaveTimer.current) clearTimeout(viewportSaveTimer.current);
    viewportSaveTimer.current = setTimeout(() => {
      const v = viewerRef.current;
      if (!v) return;
      try {
        localStorage.setItem(viewportKey, JSON.stringify({
          zoom: v.getZoom(),
          left: v.getScrollLeft(),
          top: v.getScrollTop(),
        }));
      } catch { /* ignore */ }
    }, 400);
  }, [viewportKey]);

  useEffect(() => {
    const v = viewerRef.current;
    if (!v || !viewportKey) return;
    const onScroll = () => scheduleViewportSave();
    const el = v.getViewport();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [viewportKey, scheduleViewportSave, viewportEl]);

  // ---------------------------------------------------------------------------
  // 挂载:定位 viewport、恢复视口或初始化缩放
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    setViewportEl(viewer.getViewport());
    const t = setTimeout(() => {
      viewer.resize();
      // 优先恢复上次视口
      let restored = false;
      try {
        const key = useWorkspace.getState().projectId ? `a2.viewport.${useWorkspace.getState().projectId}` : null;
        const raw = key ? localStorage.getItem(key) : null;
        if (raw) {
          const saved = JSON.parse(raw) as { zoom?: number; left?: number; top?: number };
          if (typeof saved.zoom === "number" && typeof saved.left === "number" && typeof saved.top === "number") {
            viewer.setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, saved.zoom)));
            viewer.scrollTo(saved.left, saved.top);
            setZoom(viewer.getZoom());
            restored = true;
          }
        }
      } catch { /* ignore */ }
      restoredViewportRef.current = restored;
      if (!restored) {
        viewer.setZoom(0.45);
        setZoom(0.45);
      }
    }, 80);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // 首次加载且未恢复视口时,居中第一个页面
  const positionedRef = useRef(false);
  useEffect(() => {
    if (positionedRef.current || !pages.length) return;
    positionedRef.current = true;
    const t = setTimeout(() => {
      const viewer = viewerRef.current;
      if (!viewer) return;
      viewer.resize();
      if (restoredViewportRef.current) return;
      const first = pages[0];
      centerOn(first.posX + first.width / 2, first.posY + (first.height + 34) / 2, 0.45);
    }, 120);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages.length]);

  // 聚焦页面(供左栏/Agent 调用) + 容器尺寸变化时重测
  useEffect(() => {
    (window as unknown as { __resizeCanvas?: () => void }).__resizeCanvas = () => {
      viewerRef.current?.resize();
    };
    (window as unknown as { __focusPage?: (id: number) => void }).__focusPage = (id) => focusPage(id);
    (window as unknown as { __fitCanvas?: () => void }).__fitCanvas = () => fitAll();
    return () => {
      delete (window as unknown as Record<string, unknown>).__resizeCanvas;
      delete (window as unknown as Record<string, unknown>).__focusPage;
      delete (window as unknown as Record<string, unknown>).__fitCanvas;
    };
  }, [focusPage, fitAll]);

  // ---------------------------------------------------------------------------
  // 流式生成自动滚动:跟随「正在生成的最新幻影页」(有序流式下最后一页即当前生成页),
  // 逐页出现逐页聚焦;用户手动平移/缩放即接管视口,本轮不再打扰(下轮自动恢复跟随)
  // ---------------------------------------------------------------------------
  const followGhostRef = useRef(0); // 已跟随的幻影页数量
  const focusEditRef = useRef<number | null>(null); // 编辑模式已聚焦的目标页
  const userSteeredRef = useRef(false); // 本轮生成中用户是否已手动接管视口
  const draftGhostCount = draft?.ghosts?.length ?? 0;
  const draftTargetId = draft?.targetPageId ?? null;
  const draftActive = draftGhostCount > 0 || draftTargetId != null;
  useEffect(() => {
    if (!draftActive) {
      followGhostRef.current = 0;
      focusEditRef.current = null;
      userSteeredRef.current = false;
      return;
    }
    if (userSteeredRef.current) return;
    if (draftGhostCount > followGhostRef.current) {
      const ghosts = useWorkspace.getState().draft?.ghosts ?? [];
      const g = ghosts[ghosts.length - 1];
      if (!g) return;
      followGhostRef.current = draftGhostCount;
      // 幻影画框不在 pages 里,按坐标聚焦(不改变选中态)
      const viewer = viewerRef.current;
      if (!viewer) { followGhostRef.current = 0; return; }
      const fit = Math.min(
        viewer.getContainerWidth() / (g.width + 200),
        viewer.getContainerHeight() / (g.height + 200),
        1,
      );
      const z = Math.max(0.15, fit * 0.92);
      viewer.setZoom(z);
      setZoom(z);
      centerOn(g.posX + g.width / 2, g.posY + (g.height + 34) / 2, z, 300);
    } else if (!draftGhostCount && draftTargetId != null && focusEditRef.current !== draftTargetId) {
      focusEditRef.current = draftTargetId;
      focusPage(draftTargetId, 300);
    }
  }, [draftActive, draftGhostCount, draftTargetId, centerOn, focusPage, setZoom]);

  /** 生成期间用户手动操作视口(平移/滚轮/捏合缩放)后,停止本轮自动跟随 */
  const noteUserSteer = useCallback(() => {
    if (useWorkspace.getState().draft) userSteeredRef.current = true;
  }, []);

  // ---------------------------------------------------------------------------
  // Ctrl/⌘ + 滚轮:以指针为中心缩放(覆盖 InfiniteViewer 默认的中心缩放)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      noteUserSteer();
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      const viewer = viewerRef.current;
      if (!viewer) return;
      const rect = el.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * 0.0022);
      zoomAt(viewer.getZoom() * factor, e.clientX - rect.left, e.clientY - rect.top);
      scheduleViewportSave();
    };
    el.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => el.removeEventListener("wheel", onWheel, { capture: true });
  }, [zoomAt, scheduleViewportSave, noteUserSteer]);

  // ---------------------------------------------------------------------------
  // 键盘快捷键:缩放 / 删除 / 方向键微调
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;
      const ids = useWorkspace.getState().selectedPageIds;

      // Delete / Backspace:删除选中页面
      if ((e.key === "Delete" || e.key === "Backspace") && ids.length) {
        e.preventDefault();
        const pid = useWorkspace.getState().projectId;
        if (!pid) return;
        useWorkspace.getState().snapshotForUndo();
        for (const id of ids) {
          removeMut.mutate({ id, projectId: pid });
          useWorkspace.getState().removePage(id);
        }
        return;
      }
      // 方向键:微调选中画框位置(Shift ×10)
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key) && ids.length) {
        e.preventDefault();
        const d = e.shiftKey ? 40 : 4;
        const dx = e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0;
        const dy = e.key === "ArrowUp" ? -d : e.key === "ArrowDown" ? d : 0;
        const { pages: ps } = useWorkspace.getState();
        for (const id of ids) {
          const p = ps.find((x) => x.id === id);
          if (!p) continue;
          updatePageLocal(id, { posX: p.posX + dx, posY: p.posY + dy });
          persistPage(id, { posX: Math.round(p.posX + dx), posY: Math.round(p.posY + dy) });
        }
        return;
      }
      // 数字 0:恢复 100% · 数字 1:适应全部
      if (e.key === "0") {
        e.preventDefault();
        const viewer = viewerRef.current;
        if (!viewer) return;
        noteUserSteer();
        zoomAt(1);
        scheduleViewportSave();
        return;
      }
      if (e.key === "1") {
        e.preventDefault();
        noteUserSteer();
        fitAll();
        scheduleViewportSave();
        return;
      }
      // + / -:以视口中心缩放
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        const viewer = viewerRef.current;
        noteUserSteer();
        if (viewer) zoomAt(viewer.getZoom() + 0.1);
        scheduleViewportSave();
      }
      if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        const viewer = viewerRef.current;
        noteUserSteer();
        if (viewer) zoomAt(viewer.getZoom() - 0.1);
        scheduleViewportSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomAt, fitAll, updatePageLocal, persistPage, removeMut, scheduleViewportSave, noteUserSteer]);

  // 选中元素变化 → 更新 Moveable target(需查询 DOM,只能在提交后执行)
  useEffect(() => {
    const els = selectedPageIds
      .map((id) => viewportEl?.querySelector(`.a2-frame[data-page-id="${id}"]`) as HTMLElement | null)
      .filter(Boolean) as HTMLElement[];
    // eslint-disable-next-line react-hooks/set-state-in-effect -- DOM 查询结果只能提交后同步
    setTargets(els);
  }, [selectedPageIds, viewportEl, pages.length]);

  const guidelines = useMemo(
    () => pages.map((p) => `.a2-frame[data-page-id="${p.id}"]`),
    [pages],
  );

  const commitGeometry = (el: HTMLElement) => {
    const id = Number(el.dataset.pageId);
    const left = parseFloat(el.style.left);
    const top = parseFloat(el.style.top);
    const width = parseFloat(el.style.width);
    const height = parseFloat(el.style.height) - 34; // 减去标题栏
    const page = useWorkspace.getState().pages.find((p) => p.id === id);
    if (!page) return;
    const patch: Record<string, number> = {};
    if (!Number.isNaN(left) && left !== page.posX) { patch.posX = Math.round(left); }
    if (!Number.isNaN(top) && top !== page.posY) { patch.posY = Math.round(top); }
    if (!Number.isNaN(width) && width !== page.width) { patch.width = Math.round(width); }
    if (!Number.isNaN(height) && height > 100 && height !== page.height) { patch.height = Math.round(height); }
    if (Object.keys(patch).length) {
      updatePageLocal(id, patch);
      persistPage(id, patch);
    }
  };

  // 空白处按下 → 小手抓取光标(平移画布中)
  const [panning, setPanning] = useState(false);
  useEffect(() => {
    const up = () => setPanning(false);
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-[#f0f1f5]"
      style={{
        backgroundImage: "radial-gradient(circle, #d4d7e0 1px, transparent 1px)",
        backgroundSize: "24px 24px",
        cursor: panning ? "grabbing" : "grab",
      }}
      onMouseDown={(e) => {
        emptyDownRef.current = { x: e.clientX, y: e.clientY };
        const t = e.target as HTMLElement;
        if (!t.closest(".a2-frame") && !t.closest("[data-no-deselect]")) setPanning(true);
      }}
      onClick={(e) => {
        // 空白处单击(非拖拽)清空选择;frame/缩放条上的点击、拖拽平移后的抬起不算
        const t = e.target as HTMLElement;
        if (t.closest(".a2-frame") || t.closest("[data-no-deselect]")) return;
        const d = emptyDownRef.current;
        emptyDownRef.current = null;
        if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
        setSelectedPages([]);
        setSelectedElements([]);
      }}
    >
      <InfiniteViewer
        ref={viewerRef}
        className="a2-viewer relative h-full w-full"
        useWheelScroll
        useMouseDrag
        zoomRange={[MIN_ZOOM, MAX_ZOOM]}
        rangeX={[-2000, 20000]}
        rangeY={[-2000, 20000]}
        margin={400}
        threshold={40}
        onPinch={(e) => { setZoom(e.zoom); noteUserSteer(); }}
        onScroll={scheduleViewportSave}
        onDragStart={(e) => {
          const t = e.inputEvent.target as HTMLElement;
          // frame / 控制框手柄上的拖动交给 Moveable;Shift 拖动留给 Selecto 框选
          if (e.inputEvent.shiftKey || t.closest(".a2-frame") || t.closest(".moveable-control-box")) return false;
          noteUserSteer();
        }}
      >
        <div className="relative" style={{ width: 20000, height: 20000 }}>
          {pages.map((p) => <FrameView key={p.id} page={p} onFocus={() => focusPage(p.id)} />)}
          {/* 流式生成幻影画框:LLM 逐 token 输出期间渐进渲染(多页逐个出现),完成后被真实页面替换 */}
          {draft?.ghosts.map((g) => <FrameView key={`a2-draft-ghost-${g.id}`} page={g} ghost />)}
          {viewportEl && (
            <Moveable
              target={targets}
              zoom={zoom}
          draggable
          resizable
          snappable
          snapGap
          snapThreshold={8 / zoom}
          maxSnapElementGuidelineDistance={80}
          elementGuidelines={guidelines}
          verticalGuidelines={[]}
          horizontalGuidelines={[]}
          throttleDrag={0}
          throttleResize={0}
          renderDirections={["e", "s", "se"]}
          onDrag={({ target, left, top }) => {
            target.style.left = `${left}px`;
            target.style.top = `${top}px`;
          }}
          onDragEnd={({ target }) => commitGeometry(target as HTMLElement)}
          onDragGroup={({ events }) => {
            events.forEach(({ target, left, top }) => {
              target.style.left = `${left}px`;
              target.style.top = `${top}px`;
            });
          }}
          onDragGroupEnd={({ targets: ts }) => ts.forEach((t) => commitGeometry(t as HTMLElement))}
          onResize={({ target, width, height, drag }) => {
            target.style.width = `${width}px`;
            target.style.height = `${height}px`;
            target.style.left = `${drag.left}px`;
            target.style.top = `${drag.top}px`;
            const inner = target.querySelector<HTMLElement>("[data-frame-body]");
            if (inner) {
              inner.style.width = `${width}px`;
              inner.style.height = `${Math.max(100, height - 34)}px`;
              const iframe = inner.querySelector("iframe");
              if (iframe) {
                (iframe as HTMLIFrameElement).style.width = `${width}px`;
                (iframe as HTMLIFrameElement).style.height = `${Math.max(100, height - 34)}px`;
              }
            }
          }}
          onResizeEnd={({ target }) => {
            const width = parseFloat(target.style.width);
            const height = parseFloat(target.style.height) - 34;
            const id = Number(target.dataset.pageId);
            const left = parseFloat(target.style.left);
            const top = parseFloat(target.style.top);
            const patch: Record<string, number> = {};
            if (!Number.isNaN(width)) patch.width = Math.round(width);
            if (!Number.isNaN(height) && height > 100) patch.height = Math.round(height);
            if (!Number.isNaN(left)) patch.posX = Math.round(left);
            if (!Number.isNaN(top)) patch.posY = Math.round(top);
            updatePageLocal(id, patch);
            persistPage(id, patch);
          }}
        />
          )}
        </div>
      </InfiniteViewer>

      <Selecto
        dragContainer={window}
        selectableTargets={[".a2-frame"]}
        hitRate={0}
        selectByClick
        selectFromInside={false}
        toggleContinueSelect="shift"
        ratio={0}
        // 框选仅在按住 Shift 时启用;左键拖空白处用于平移画布(InfiniteViewer)
        dragCondition={(e) => !!e.inputEvent.shiftKey}
        onSelect={(e) => {
          const ids = e.selected
            .map((el) => Number((el as HTMLElement).dataset.pageId))
            .filter((n) => !Number.isNaN(n));
          setSelectedPages(ids);
          if (!ids.length) setSelectedElements([]);
        }}
      />

      {/* 缩放控制条 */}
      <div data-no-deselect className="absolute bottom-4 right-4 z-20 flex items-center gap-1 rounded-lg border border-neutral-200 bg-white/90 px-1.5 py-1 text-xs text-neutral-600 shadow-sm backdrop-blur">
        <button title="缩小 (-)" className="rounded px-1.5 py-0.5 hover:bg-neutral-100"
          onClick={() => { const v = viewerRef.current; if (v) { zoomAt(v.getZoom() - 0.1); scheduleViewportSave(); } }}>−</button>
        <button
          title="恢复 100% (按 0)"
          className="w-11 rounded px-1 py-0.5 text-center tabular-nums hover:bg-neutral-100"
          onClick={() => { zoomAt(1); scheduleViewportSave(); }}>
          {Math.round(zoom * 100)}%
        </button>
        <button title="放大 (+)" className="rounded px-1.5 py-0.5 hover:bg-neutral-100"
          onClick={() => { const v = viewerRef.current; if (v) { zoomAt(v.getZoom() + 0.1); scheduleViewportSave(); } }}>+</button>
        <span className="mx-0.5 h-4 w-px bg-neutral-200" />
        <button title="适应全部页面 (按 1)" className="rounded px-1.5 py-0.5 hover:bg-neutral-100"
          onClick={() => { fitAll(); scheduleViewportSave(); }}>适应</button>
      </div>
    </div>
  );
}
