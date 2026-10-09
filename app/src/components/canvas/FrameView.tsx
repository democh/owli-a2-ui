/**
 * 画布上的单个 Frame(页面画框)
 * header(标题/设备/操作) + iframe(渲染器) + 交互 overlay
 */
import { memo, useEffect, useRef, useState } from "react";
import {
  Monitor, Smartphone, Tablet, Laptop, Crosshair, Copy, Trash2, MoreHorizontal,
  Pencil, MessageCircleQuestion, SearchCheck, Camera, Download,
} from "lucide-react";
import { toast } from "sonner";
import type { PageState } from "@/stores/workspaceStore";
import { useWorkspace } from "@/stores/workspaceStore";
import { IPC_SOURCE, postToIframe, type RendererMessage } from "@/lib/a2ui-ipc";
import { usePageOps } from "@/hooks/usePageOps";
import { trpc } from "@/providers/trpc";
import { DEVICES, type DeviceId } from "@contracts/a2ui";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";

/** 内联文本编辑会话:双击 iframe 内文本类组件后由宿主在组件上方弹出编辑器 */
interface TextEditState {
  aid: string;
  prop: string;
  value: string;
  rect: { x: number; y: number; w: number; h: number };
}

const DEVICE_ICON = { desktop: Monitor, laptop: Laptop, tablet: Tablet, mobile: Smartphone } as const;

export const FrameView = memo(function FrameView({
  page,
  onFocus,
  ghost,
  mapMode,
  lazy,
}: {
  page: PageState;
  onFocus?: () => void;
  ghost?: boolean;
  /** 页面地图模式(zoom<35%):不渲染 iframe,只显示轮廓+标题 */
  mapMode?: boolean;
  /** 视口虚拟化:画布外画框不挂载 iframe,仅保留占位 */
  lazy?: boolean;
}) {
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
    const requestHighlight = useWorkspace((s) => s.requestHighlight);
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

  // §6.3 页面菜单:重命名 / 生成移动端·平板版本 / 对该页面提问 / 运行 UX 评审 / 创建快照 / 导出该页面
  const sendPrompt = (window as unknown as {
    __sendPrompt?: (prompt: string, opts?: { mode?: string; autoSend?: boolean; pageId?: string; pageTitle?: string }) => void;
  }).__sendPrompt;
  const renameMut = trpc.pages.update.useMutation({
    onSuccess: () => toast.success("页面已重命名"),
    onError: () => toast.error("重命名持久化失败,刷新后将回退"),
  });
  const renamePage = (raw: string) => {
    const t = raw.trim().slice(0, 100);
    if (!t || t === page.title) return;
    snapshotForUndo();
    updatePageLocal(page.id, { title: t });
    renameMut.mutate({ id: page.id, projectId: page.projectId, title: t });
  };
  const snapshotMut = trpc.versions.save.useMutation({
    onSuccess: () => toast.success("已创建快照(可在顶栏「版本」查看)"),
    onError: () => toast.error("快照创建失败"),
  });
  const workspaceRevQ = trpc.workspace.get.useQuery({ projectId: page.projectId });
  const exportPageMut = trpc.exports.create.useMutation({
    onSuccess: (r) => {
      toast.success(`单页导出成功(${r.fileCount} 个文件),已开始下载`);
      window.open(`/api/exports/${r.exportId}/download`, "_blank");
    },
    onError: (e) => toast.error(`导出失败:${e.message.slice(0, 140)}`),
  });
  const exportPage = () => {
    if (!page.surfaceId) { toast.error("该页面没有 Design IR 数据,无法导出"); return; }
    exportPageMut.mutate({
      projectId: page.projectId,
      baseRevision: workspaceRevQ.data?.revision ?? 0,
      projectName: page.title || "A2UI 页面",
      adapterId: "shadcn-tailwind",
      surfaceIds: [page.surfaceId],
    });
  };
  /** 发起 Agent 任务(页面级上下文:菜单点击不触发画框选中,桥内自带 chips) */
  const askAgent = (prompt: string, opts?: { mode?: string; autoSend?: boolean }) =>
    sendPrompt?.(prompt, { ...opts, pageId: String(page.id), pageTitle: page.title });

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
      } else if (msg.type === "commentClick") {
        // M7 评论气泡点击:选中锚点组件并打开检查器(评论流随之可见)
        setSelectedPages([page.id]);
        const nodeType = page.surface.components[msg.nodeId]?.type ?? "Col";
        setSelectedElements([{ pageId: page.id, aid: msg.nodeId, componentType: nodeType }]);
        setInspectMode(true);
        requestHighlight(page.id, msg.nodeId);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id]);

  useEffect(sendSurface);
  useEffect(sendInspect, [inspectMode, selected]);

  // M7 逐节点持久 Diff 着色:该页面最近一次提交的增/改/删组件(outline 标色,直到下次提交覆盖)
  const nodeDiff = useWorkspace((s) => (page.surfaceId ? s.nodeDiffs[page.surfaceId] : undefined));
  const sendDiff = () => {
    if (!readyRef.current || !iframeRef.current?.contentWindow) return;
    postToIframe(iframeRef.current.contentWindow, { source: IPC_SOURCE, type: "setDiff", diff: nodeDiff ?? null });
  };
  useEffect(sendDiff, [nodeDiff]);

  // M7 评论锚点气泡:把该页未解决评论下发给渲染器(按 nodeId 定位)
  const commentsQ = trpc.comments.list.useQuery(
    { projectId: page.projectId, surfaceId: page.surfaceId ?? "" },
    { enabled: !!page.surfaceId },
  );
  const sendComments = () => {
    if (!readyRef.current || !iframeRef.current?.contentWindow) return;
    const list = (commentsQ.data ?? [])
      .filter((c) => !c.resolved && c.nodeId)
      .map((c) => ({ id: c.id, nodeId: c.nodeId!, body: c.body, authorName: c.authorName, resolved: c.resolved }));
    postToIframe(iframeRef.current.contentWindow, { source: IPC_SOURCE, type: "setComments", comments: list });
  };
  useEffect(sendComments, [commentsQ.data]);

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
      onMouseDown={(e) => {
        if (ghost) return;
        downPosRef.current = { x: e.clientX, y: e.clientY };
        // down 即选中(非 Shift):平移/框选/缩放后的 gesto click 抑制会吞掉随后的 click 事件,
        // 依赖 onClick 选中会导致平移后首次点选无响应(实测缺陷);Figma 同类工具均为 down 选中,
        // click 的 shift 切换多选分支保留不变
        if (!e.shiftKey) setSelectedPages([page.id]);
      }}
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
            <span className="mx-0.5 h-4 w-px bg-neutral-200" />
            {/* §6.3 页面菜单 */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button title="页面菜单" className="rounded p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-600"
                  onClick={(e) => e.stopPropagation()}>
                  <MoreHorizontal size={12} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48" onClick={(e) => e.stopPropagation()}>
                <DropdownMenuLabel className="text-[10px] text-neutral-400">页面操作</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => {
                  const name = window.prompt("重命名页面", page.title);
                  if (name != null) renamePage(name);
                }}>
                  <Pencil size={13} /> 重命名页面
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() =>
                  askAgent(`为页面「${page.title}」生成移动端版本:保持信息架构与核心内容一致,按移动端优先重排布局(单列结构、底部主操作、大触控目标)。`, { mode: "create_frame", autoSend: true })
                }>
                  <Smartphone size={13} /> 生成移动端版本
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() =>
                  askAgent(`为页面「${page.title}」生成平板版本:保持信息架构一致,适配中等屏幕宽度的两栏/网格布局。`, { mode: "create_frame", autoSend: true })
                }>
                  <Tablet size={13} /> 生成平板版本
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => askAgent(`关于页面「${page.title}」:`, { autoSend: false })}>
                  <MessageCircleQuestion size={13} /> 对该页面提问
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() =>
                  askAgent(`请对页面「${page.title}」运行完整 UX 评审:信息架构、视觉层级、交互完整性、可访问性,输出问题清单与修复建议。`, { mode: "review_only", autoSend: true })
                }>
                  <SearchCheck size={13} /> 运行 UX 评审
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() =>
                  snapshotMut.mutate({ projectId: page.projectId, label: `快照 · ${page.title} · ${new Date().toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}` })
                } disabled={snapshotMut.isPending}>
                  <Camera size={13} /> 创建快照
                </DropdownMenuItem>
                <DropdownMenuItem onClick={exportPage} disabled={exportPageMut.isPending}>
                  <Download size={13} /> {exportPageMut.isPending ? "导出中…" : "导出该页面"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
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
        {mapMode && !ghost ? (
          /* 页面地图:低缩放下只显示轮廓与标题(文档 §7.1) */
          <div className="flex h-full w-full items-center justify-center bg-neutral-100">
            <span className="max-w-[90%] truncate text-sm font-medium text-neutral-400">{page.title}</span>
          </div>
        ) : lazy && !ghost && !draftState ? (
          /* 视口虚拟化:画布外只保留占位框 */
          <div className="flex h-full w-full items-center justify-center bg-neutral-50">
            <span className="text-xs text-neutral-300">{page.title}</span>
          </div>
        ) : showSkeleton ? (
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
        {/* 幻影画框流式生成中:内容渐进到达时的微光遮罩(增强"正在生成"感知) */}
        {ghost && !showSkeleton && (
          <div className="pointer-events-none absolute inset-0 z-10 animate-pulse bg-indigo-100/25" />
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
