/**
 * 画布上的单个 Frame(页面画框)
 * header(标题/设备/操作) + iframe(渲染器) + 交互 overlay
 */
import { memo, useEffect, useRef, useState } from "react";
import { Monitor, Smartphone, Tablet, Laptop, Crosshair, Copy, Trash2 } from "lucide-react";
import type { PageState } from "@/stores/workspaceStore";
import { useWorkspace } from "@/stores/workspaceStore";
import { IPC_SOURCE, postToIframe, type RendererMessage } from "@/lib/a2ui-ipc";
import { usePageOps } from "@/hooks/usePageOps";
import { trpc } from "@/providers/trpc";
import { DEVICES, type DeviceId } from "@contracts/a2ui";

/** 内联文本编辑会话:双击 iframe 内文本类组件后由宿主在组件上方弹出编辑器 */
interface TextEditState {
  aid: string;
  prop: string;
  value: string;
  rect: { x: number; y: number; w: number; h: number };
}

const DEVICE_ICON = { desktop: Monitor, laptop: Laptop, tablet: Tablet, mobile: Smartphone } as const;

export const FrameView = memo(function FrameView({ page, onFocus, ghost }: { page: PageState; onFocus?: () => void; ghost?: boolean }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const readyRef = useRef(false);
  // 上次下发的 surface 引用:surface 全程不可变更新,引用相同即内容相同,
  // 避免每次 effect 都对整棵组件树做 JSON.stringify 全量比对
  const lastSentRef = useRef<{ surface: PageState["surface"]; preset: string } | null>(null);
  // mousedown 坐标(用于区分"单击选中"与"拖拽移动")
  const downPosRef = useRef<{ x: number; y: number } | null>(null);

  const preset = useWorkspace((s) => s.preset);
  const selected = useWorkspace((s) => s.selectedPageIds.includes(page.id));
  // edit 模式流式草稿:LLM 逐 token 输出期间在该画框内就地渐进预览(不污染 page.surface)
  const draftState = useWorkspace((s) => (!ghost && s.draft?.targetPageId === page.id ? s.draft : null));
  const draftSurface = draftState?.surface ?? null;
  const liveSurface = draftSurface ?? page.surface;
  const generating = !!ghost || !!draftState;
  // 幻影画框还没有任何完整组件 → 骨架屏;edit 模式等首个组件闭合 → 微光遮罩
  const showSkeleton = generating && Object.keys(liveSurface.components).length === 0;
  const showShimmer = !ghost && !!draftState && !draftSurface;
  const inspectMode = useWorkspace((s) => s.inspectMode);
  const setInspectMode = useWorkspace((s) => s.setInspectMode);
  const setSelectedPages = useWorkspace((s) => s.setSelectedPages);
  const setSelectedElements = useWorkspace((s) => s.setSelectedElements);
  const removePage = useWorkspace((s) => s.removePage);
  const addPage = useWorkspace((s) => s.addPage);
  const snapshotForUndo = useWorkspace((s) => s.snapshotForUndo);
  const updatePageLocal = useWorkspace((s) => s.updatePageLocal);

  // 内联文本编辑(inspect 模式下双击文本组件触发)
  const [textEdit, setTextEdit] = useState<TextEditState | null>(null);

  const utils = trpc.useUtils();
  const duplicateMut = trpc.pages.duplicate.useMutation({
    onSuccess: async (r) => {
      // 用接口返回的新页面 id 精确取回,避免同名"副本"串页
      const data = await utils.projects.get.fetch({ id: page.projectId });
      const fresh = data.pages.find((p) => p.id === r.id);
      if (fresh) {
        snapshotForUndo();
        addPage({ ...fresh, surface: fresh.surface, device: fresh.device as PageState["device"] });
      }
    },
  });
  const removeMut = trpc.pages.remove.useMutation({
    onSuccess: () => { snapshotForUndo(); removePage(page.id); },
  });
  const persistMut = trpc.pages.update.useMutation();
  /** 悬浮条切换设备:本地即时生效 + 持久化(与拖动改尺寸同链路) */
  const switchDevice = (device: DeviceId) => {
    if (page.device === device) return;
    const d = DEVICES[device];
    updatePageLocal(page.id, { device, width: d.width, height: d.height });
    persistMut.mutate({ id: page.id, projectId: page.projectId, device, width: d.width, height: d.height });
  };
  // 手动编辑与 AI 编辑共用同一条 op 链路(快照 → applyOps → 持久化)
  const applyPageOps = usePageOps();

  const sendSurface = () => {
    if (!readyRef.current || !iframeRef.current?.contentWindow) return;
    const last = lastSentRef.current;
    if (last && last.surface === liveSurface && last.preset === preset) return;
    lastSentRef.current = { surface: liveSurface, preset };
    postToIframe(iframeRef.current.contentWindow, {
      source: IPC_SOURCE, type: "setSurface", doc: liveSurface, preset,
    });
  };
  const sendInspect = () => {
    postToIframe(iframeRef.current?.contentWindow ?? null, {
      source: IPC_SOURCE, type: "setInspect", on: inspectMode && selected,
    });
  };

  // iframe ↔ host 消息
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      if (e.source !== iframeRef.current?.contentWindow) return;
      const msg = e.data as RendererMessage;
      if (msg?.source !== IPC_SOURCE) return;
      if (msg.type === "ready") {
        readyRef.current = true;
        lastSentRef.current = null;
        sendSurface();
        sendInspect();
      } else if (msg.type === "select") {
        // 元素多选:渲染器回传当前选中的全部组件
        setSelectedPages([page.id]);
        setSelectedElements(msg.items.map((it) => ({ pageId: page.id, aid: it.aid, componentType: it.componentType })));
      } else if (msg.type === "textEdit") {
        // 双击文本组件:弹出内联编辑器(浮层定位在组件上方)
        setTextEdit({ aid: msg.aid, prop: msg.prop, value: msg.value, rect: msg.rect });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id]);

  useEffect(sendSurface);
  useEffect(sendInspect, [inspectMode, selected]);

  // 图层树/检查器请求高亮本页组件(闪烁一次)
  const highlightReq = useWorkspace((s) => s.highlightReq);
  useEffect(() => {
    if (!highlightReq || highlightReq.pageId !== page.id) return;
    postToIframe(iframeRef.current?.contentWindow ?? null, {
      source: IPC_SOURCE, type: "highlight", aid: highlightReq.aid,
    });
  }, [highlightReq, page.id]);

  const inspectActive = inspectMode && selected;

  // 退出 inspect 时放弃未提交的内联编辑(渲染期调整状态,避免 effect 级联渲染)
  const [prevInspectActive, setPrevInspectActive] = useState(inspectActive);
  if (inspectActive !== prevInspectActive) {
    setPrevInspectActive(inspectActive);
    if (!inspectActive && textEdit) setTextEdit(null);
  }

  /** 提交内联文本编辑:生成 replaceProps op,走与 AI 编辑相同的不可变更新 + 持久化 + 撤销链路 */
  const commitTextEdit = () => {
    if (!textEdit) return;
    const { aid, prop, value } = textEdit;
    setTextEdit(null);
    const node = page.surface.components[aid];
    if (!node || node.props[prop] === value) return;
    applyPageOps(page, [{ op: "replaceProps", id: aid, props: { [prop]: value } }]);
  };

  // Esc 退出组件选取
  useEffect(() => {
    if (!inspectActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setInspectMode(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspectActive]);

  const DevIcon = DEVICE_ICON[page.device] ?? Monitor;

  return (
    <div
      className={`${ghost ? "a2-ghost" : "a2-frame group"} absolute select-none`}
      data-page-id={page.id}
      style={{ left: page.posX, top: page.posY, width: page.width, height: page.height + 34 }}
      onMouseDown={(e) => { if (!ghost) downPosRef.current = { x: e.clientX, y: e.clientY }; }}
      onClick={(e) => {
        if (ghost) return; // 幻影画框不参与选中/拖拽
        // 单击选中(Shift 切换多选);拖拽后的抬起不算点击
        const d = downPosRef.current;
        downPosRef.current = null;
        if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
        if (e.shiftKey) {
          const cur = useWorkspace.getState().selectedPageIds;
          setSelectedPages(cur.includes(page.id) ? cur.filter((i) => i !== page.id) : [...cur, page.id]);
        } else {
          setSelectedPages([page.id]);
        }
      }}
    >
      {/* 悬浮工具条:hover/选中时浮在标题栏上方——设备切换 + 页面操作(pb 桥接间隙防 hover 抖动) */}
      {!ghost && (
        <div className={`absolute bottom-full right-0 z-30 pb-1.5 ${selected ? "block" : "hidden group-hover:block"}`} data-no-selecto>
          <div className="flex items-center gap-0.5 rounded-lg border border-neutral-200 bg-white/95 px-1 py-1 shadow-lg backdrop-blur">
            {(Object.keys(DEVICES) as DeviceId[]).map((d) => {
              const Icon = DEVICE_ICON[d];
              const active = page.device === d;
              return (
                <button key={d} title={`${DEVICES[d].label} ${DEVICES[d].width}×${DEVICES[d].height}`}
                  onClick={(e) => { e.stopPropagation(); switchDevice(d); }}
                  className={`rounded p-1 transition ${active ? "bg-indigo-100 text-indigo-600" : "text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"}`}>
                  <Icon size={12} />
                </button>
              );
            })}
            <span className="mx-0.5 h-4 w-px bg-neutral-200" />
            <button
              title={inspectActive ? "退出组件选取 (Esc)" : "选取页面内组件(与 AI 对话)"}
              className={`rounded p-1 transition ${inspectActive ? "bg-indigo-500 text-white" : "text-neutral-400 hover:bg-indigo-50 hover:text-indigo-600"}`}
              onClick={(e) => { e.stopPropagation(); setInspectMode(!inspectActive); }}
            >
              <Crosshair size={12} />
            </button>
            <button title="复制页面" className="rounded p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-600"
              onClick={(e) => { e.stopPropagation(); duplicateMut.mutate({ id: page.id, projectId: page.projectId }); }}>
              <Copy size={12} />
            </button>
            <button title="删除页面" className="rounded p-1 text-neutral-400 transition hover:bg-red-50 hover:text-red-500"
              onClick={(e) => { e.stopPropagation(); removeMut.mutate({ id: page.id, projectId: page.projectId }); }}>
              <Trash2 size={12} />
            </button>
          </div>
        </div>
      )}
      {/* frame 标题栏(双击聚焦适配) */}
      <div
        onDoubleClick={(e) => { e.stopPropagation(); if (!ghost) onFocus?.(); }}
        className={`flex h-[34px] items-center gap-2 rounded-t-lg border border-b-0 px-3 text-xs transition-colors ${
          generating ? "border-indigo-400 bg-indigo-500/10 text-indigo-700"
          : selected ? "border-indigo-500 bg-indigo-500/10 text-indigo-700"
          : "border-neutral-300 bg-white/90 text-neutral-600"
        }`}
      >
        <DevIcon size={13} className="shrink-0" />
        <span className="truncate font-medium">{page.title}</span>
        <span className="text-[10px] opacity-50">{page.width}×{page.height}</span>
        {generating && (
          <span className="ml-auto flex items-center gap-1.5 text-[10px] font-medium text-indigo-500">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-indigo-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-indigo-500" />
            </span>
            AI 生成中…
          </span>
        )}
        {inspectActive && (
          <span className="ml-auto rounded bg-indigo-500 px-1.5 py-0.5 text-[10px] font-medium text-white">选取中</span>
        )}
      </div>
      {/* iframe 渲染区 */}
      <div
        data-frame-body
        className={`relative overflow-hidden rounded-b-lg border bg-white shadow-[0_8px_40px_rgba(0,0,0,0.10)] ${
          generating ? "border-indigo-400 shadow-[0_8px_40px_rgba(99,102,241,0.18)]" : selected ? "border-indigo-500" : "border-neutral-300"
        }`}
        style={{ width: page.width, height: page.height }}
      >
        {/* inspect 模式提示 */}
        {inspectActive && !textEdit && (
          <div className="absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-full bg-indigo-600/95 px-3.5 py-1.5 text-xs font-medium text-white shadow-lg backdrop-blur">
            点击选中组件 · 双击文本直接编辑 · Esc 退出
          </div>
        )}
        {/* 内联文本编辑器:双击文本组件后浮在其上方;Enter/失焦提交,Esc 取消 */}
        {textEdit && (
          <textarea
            autoFocus
            value={textEdit.value}
            onChange={(e) => setTextEdit({ ...textEdit, value: e.target.value })}
            onBlur={commitTextEdit}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitTextEdit(); }
              if (e.key === "Escape") { e.preventDefault(); setTextEdit(null); }
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className="absolute z-30 resize-none overflow-hidden rounded-md bg-white/95 px-2 py-1 text-sm leading-snug shadow-xl outline outline-2 outline-indigo-500"
            style={{
              left: Math.max(4, Math.min(textEdit.rect.x, page.width - 168)),
              top: Math.max(4, textEdit.rect.y),
              width: Math.max(160, textEdit.rect.w),
              minHeight: Math.max(36, textEdit.rect.h),
            }}
          />
        )}
        {showSkeleton ? (
          <PageSkeleton />
        ) : (
          <iframe
            ref={iframeRef}
            src="/render"
            title={page.title}
            sandbox="allow-scripts allow-same-origin"
            className="block h-full w-full border-0"
            style={{ width: page.width, height: page.height }}
            tabIndex={-1}
          />
        )}
        {/* edit 模式等首个组件闭合:微光遮罩,保留原有内容可见 */}
        {showShimmer && (
          <div className="pointer-events-none absolute inset-0 z-10 animate-pulse bg-indigo-50/50" />
        )}
        {/* 画布交互 overlay:inspect 时放行点击给 iframe */}
        {!inspectActive && !ghost && (
          <div
            className="absolute inset-0 z-10"
            style={{ cursor: selected ? "move" : "default" }}
            onDoubleClick={() => { setSelectedPages([page.id]); setInspectMode(true); }}
          />
        )}
      </div>
    </div>
  );
});

/** 幻影画框骨架屏:第一个组件闭合前的页面结构占位(Navbar / Hero / 卡片行) */
function PageSkeleton() {
  const block = "animate-pulse rounded-md bg-neutral-100";
  return (
    <div className="absolute inset-0 z-10 flex flex-col overflow-hidden bg-white">
      {/* Navbar */}
      <div className="flex items-center justify-between border-b border-neutral-100 px-8 py-4">
        <div className={`${block} h-6 w-24`} />
        <div className="flex gap-3">
          <div className={`${block} h-4 w-14`} />
          <div className={`${block} h-4 w-14`} />
          <div className={`${block} h-4 w-14`} />
        </div>
        <div className={`${block} h-7 w-20 rounded-full`} />
      </div>
      {/* Hero */}
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-16">
        <div className={`${block} h-8 w-3/5`} />
        <div className={`${block} h-8 w-2/5`} />
        <div className={`${block} mt-1 h-4 w-1/2`} />
        <div className="mt-3 flex gap-3">
          <div className={`${block} h-9 w-28 rounded-full`} />
          <div className={`${block} h-9 w-28 rounded-full`} />
        </div>
      </div>
      {/* 卡片行 */}
      <div className="grid grid-cols-3 gap-4 px-8 pb-8">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-col gap-2 rounded-xl border border-neutral-100 p-4">
            <div className={`${block} h-8 w-8 rounded-lg`} />
            <div className={`${block} h-4 w-2/3`} />
            <div className={`${block} h-3 w-full`} />
            <div className={`${block} h-3 w-4/5`} />
          </div>
        ))}
      </div>
    </div>
  );
}
