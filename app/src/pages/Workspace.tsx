/**
 * 工作台:顶栏 + 左页面栏 + 画布 + 右检查器 + 底部悬浮对话框
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  ArrowLeft, Layers, PanelLeftClose, PanelLeftOpen, Redo2, Rows3, Undo2, Sparkles, FileUp, LayoutTemplate, Save, CircleDot,
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useUndoRedo } from "@/hooks/useUndoRedo";
import { trpc } from "@/providers/trpc";
import { useWorkspace } from "@/stores/workspaceStore";
import { useRunStore } from "@/stores/runStore";
import { STATUS_LABELS } from "@/lib/statusLabels";
import { useUiStore } from "@/stores/uiStore";
import { toast } from "sonner";
import { CanvasStage } from "@/components/canvas/CanvasStage";
import { LeftPanel } from "@/components/panels/LeftPanel";
import { AgentPanelV2 } from "@/components/agent/AgentPanelV2";
import { PublishMenu } from "@/components/panels/PublishMenu";
import { VersionsMenu } from "@/components/panels/VersionsMenu";
import { ExportMenu } from "@/components/panels/ExportMenu";
import { PRESET_IDS, STYLE_PRESETS, engineDisplayName, type PresetId } from "@contracts/a2ui";

export default function Workspace() {
  const { user, isLoading } = useAuth({ redirectOnUnauthenticated: true });
  const { id } = useParams<{ id: string }>();
  const projectId = Number(id);
  const navigate = useNavigate();

  const projectName = useWorkspace((s) => s.projectName);
  const preset = useWorkspace((s) => s.preset);
  const setPreset = useWorkspace((s) => s.setPreset);
  const leftPanelVisible = useWorkspace((s) => s.leftPanelVisible);
  const setLeftPanelVisible = useWorkspace((s) => s.setLeftPanelVisible);
  const { doUndo, doRedo } = useUndoRedo();

  const [settingsOpen, setSettingsOpen] = useState(false);
  // M5.3 TSX 导入入口
  const [importOpen, setImportOpen] = useState(false);
  // M7 模板库入口
  const [templatesOpen, setTemplatesOpen] = useState(false);

  const conversationId = useWorkspace((s) => s.conversationId);
  const selectedPageIds = useWorkspace((s) => s.selectedPageIds);
  const selectedElements = useWorkspace((s) => s.selectedElements);
  const pages = useWorkspace((s) => s.pages);
  /** Agent 上下文 chips(页面/元素,与画布选中联动);surfaceId 供后端 scope 精确匹配(frameId 语义=surfaceId) */
  const selectedChips = useMemo(() => {
    if (selectedElements.length) {
      return selectedElements.slice(0, 5).map((el) => {
        const page = pages.find((p) => p.id === el.pageId);
        return {
          kind: "element" as const,
          pageId: String(el.pageId),
          surfaceId: page?.surfaceId,
          aid: el.aid,
          label: `${page?.title ?? "页面"} · ${el.componentType}#${el.aid}`,
        };
      });
    }
    return selectedPageIds.slice(0, 3).map((pid) => {
      const page = pages.find((p) => p.id === pid);
      return {
        kind: "page" as const,
        pageId: String(pid),
        surfaceId: page?.surfaceId,
        title: page?.title ?? "",
      };
    });
  }, [selectedElements, selectedPageIds, pages]);

  // workspace 主数据(boards/frames/IR)——Run 提交后由 onCommitted 刷新
  const workspaceQ2 = trpc.workspace.get.useQuery({ projectId }, { enabled: !!user && !!projectId });
  // M5 导出:Design IR → 可构建 React 工程 zip(M5-1 完整门禁 + M5-2 适配器选择,见 ExportMenu)
  const refetchWorkspace = () => workspaceQ2.refetch();

  const projectQ = trpc.projects.get.useQuery({ id: projectId }, { enabled: !!user && !!projectId });
  const updateProjectMut = trpc.projects.update.useMutation();

  // 左栏显隐切换后,画布容器尺寸变化需重测
  const toggleLeftPanel = (v: boolean) => {
    setLeftPanelVisible(v);
    setTimeout(() => (window as unknown as { __resizeCanvas?: () => void }).__resizeCanvas?.(), 120);
  };

  // 全局紧凑模式(uiStore 持久化,默认紧凑)
  const compact = useUiStore((s) => s.compact);
  const toggleCompact = useUiStore((s) => s.toggleCompact);

  // 工作台快捷键(文档 §13):⌘B 左栏 / ⌘J Agent 面板 / ⌘. 专注模式
  const [agentVisible, setAgentVisible] = useState(true);
  const [focusMode, setFocusMode] = useState(false);

  // §4.4 顶栏 Agent 状态灯(§4.4 表格文案)
  const agentTurn = useRunStore((s) => (s.activeRunId ? s.turns[s.activeRunId] ?? null : null));
  const agentStatus = useMemo(() => {
    if (!agentTurn) return { label: "空闲", color: "bg-slate-400" };
    const s = agentTurn.status;
    if (s === "completed") return { label: "已完成", color: "bg-emerald-500" };
    if (s === "failed") return { label: "失败,可重试", color: "bg-red-500" };
    if (s === "cancelled" || s === "cancelling") return { label: "已取消", color: "bg-slate-400" };
    if (s === "awaiting_clarification" || s === "awaiting_approval") return { label: "等待确认", color: "bg-amber-500" };
    if (s === "ux_reviewing") return { label: "UX 评审中", color: "bg-blue-500" };
    const base = STATUS_LABELS[s] ?? agentTurn.label;
    return { label: agentTurn.progress ? `${base} ${Math.round(agentTurn.progress * 100)}%` : base, color: "bg-blue-500" };
  }, [agentTurn]);
  const [skillsOpen, setSkillsOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "b" || e.key === "B") {
        e.preventDefault();
        if (focusMode) setFocusMode(false);
        toggleLeftPanel(!leftPanelVisible);
      } else if (e.key === "j" || e.key === "J") {
        e.preventDefault();
        if (focusMode) setFocusMode(false);
        setAgentVisible((v) => !v);
        setTimeout(() => (window as unknown as { __resizeCanvas?: () => void }).__resizeCanvas?.(), 120);
      } else if (e.key === ".") {
        e.preventDefault();
        setFocusMode((v) => !v);
        setTimeout(() => (window as unknown as { __resizeCanvas?: () => void }).__resizeCanvas?.(), 120);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftPanelVisible, focusMode]);

  // 初始化 store:优先使用 Design IR 投影(Run 提交后画布即时可见);无 frames 时回退旧 pages
  useEffect(() => {
    const w = workspaceQ2.data;
    if (user && projectId && w?.legacyPages?.length) {
      useWorkspace.getState().initProject({
        id: projectId,
        name: w.boards[0]?.title ? projectName : projectName,
        preset: (w.doc as { theme?: { preset?: PresetId } })?.theme?.preset ?? "shadcn",
        pages: w.legacyPages.map((p) => ({
          id: p.id, projectId: p.projectId, title: p.title,
          device: p.device as never, surface: p.surface as never,
          posX: p.posX, posY: p.posY, width: p.width, height: p.height,
          surfaceId: p.surfaceId,
          boardId: p.boardId,
          boardTitle: p.boardTitle,
        })),
      });
      return;
    }
    const d = projectQ.data;
    if (!d) return;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceQ2.data?.revision, projectQ.data?.id, user, projectId]);

  // §2 状态栏:画布缩放/坐标(CanvasStage 100ms 节流广播)+ 选中对象
  const [canvasInfo, setCanvasInfo] = useState({ zoom: 0.45, x: 0, y: 0 });
  useEffect(() => {
    const onViewport = (e: Event) => {
      const d = (e as CustomEvent<{ zoom: number; x: number; y: number }>).detail;
      if (d) setCanvasInfo({ zoom: d.zoom, x: d.x, y: d.y });
    };
    window.addEventListener("a2:viewport", onViewport);
    return () => window.removeEventListener("a2:viewport", onViewport);
  }, []);
  const selectionLabel = selectedElements.length
    ? selectedElements.slice(0, 2).map((el) => `${el.componentType}#${el.aid}`).join(" · ") + (selectedElements.length > 2 ? ` 等 ${selectedElements.length} 个` : "")
    : selectedPageIds.length
      ? `页面 ×${selectedPageIds.length}`
      : "未选中";

  // 撤销/重做 + 左栏显隐(Ctrl/Cmd+B)快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) doRedo(); else doUndo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        doRedo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleLeftPanel(!useWorkspace.getState().leftPanelVisible);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (isLoading || !user) return <FullLoading />;
  if (projectQ.isLoading) return <FullLoading />;
  if (projectQ.error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-neutral-50">
        <p className="text-sm text-neutral-500">项目不存在或没有访问权限</p>
        <button onClick={() => navigate("/")} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm text-white">返回项目列表</button>
      </div>
    );
  }

  return (
    <div className={`flex h-screen flex-col overflow-hidden bg-white ${compact ? "a2-compact" : ""}`}>
      {/* 顶栏 */}
      <header className="z-20 flex h-12 shrink-0 items-center gap-2 border-b border-neutral-200 bg-white px-3">
        <button onClick={() => navigate("/")}
          className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-neutral-500 transition hover:bg-neutral-100">
          <ArrowLeft size={15} />
        </button>
        <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-indigo-600 text-white">
          <Layers size={12} />
        </span>
        <span className="max-w-[240px] truncate text-sm font-semibold">{projectName}</span>

        {/* §4.4 Agent 状态灯 */}
        <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-500" title="Agent 当前状态">
          <CircleDot className={`size-3 ${agentStatus.color}`} />
          Agent:{agentStatus.label}
        </span>

        <div className="mx-2 h-5 w-px bg-neutral-200" />

        {/* 风格切换 */}
        <div className="flex items-center gap-1 rounded-xl bg-neutral-100 p-1">
          {PRESET_IDS.map((pid) => (
            <button key={pid}
              title={STYLE_PRESETS[pid].desc}
              onClick={() => {
                setPreset(pid);
                updateProjectMut.mutate({ id: projectId, preset: pid });
              }}
              className={`rounded-lg px-2.5 py-1 text-xs transition ${
                preset === pid ? "bg-white font-medium text-indigo-600 shadow-sm" : "text-neutral-500 hover:text-neutral-700"
              }`}>
              {STYLE_PRESETS[pid].label}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-1">
          <button
            title="导入 TSX 页面"
            onClick={() => setImportOpen(true)}
            className="rounded-lg p-2 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-600">
            <FileUp size={15} />
          </button>
          <button
            title="模板库"
            onClick={() => setTemplatesOpen(true)}
            className="rounded-lg p-2 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-600">
            <LayoutTemplate size={15} />
          </button>
          <button
            title="Skill 市场(浏览/提交/审核)"
            onClick={() => setSkillsOpen(true)}
            className="rounded-lg p-2 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-600">
            <Sparkles size={15} />
          </button>
          <ExportMenu projectId={projectId} baseRevision={workspaceQ2.data?.revision ?? 0} projectName={projectName || "A2UI 项目"} />
          <button
            title={compact ? "切换为舒适密度" : "切换为全局紧凑密度"}
            onClick={toggleCompact}
            className={`rounded-lg p-2 transition hover:bg-neutral-100 ${compact ? "text-indigo-600" : "text-neutral-400 hover:text-neutral-600"}`}>
            <Rows3 size={15} />
          </button>
          <VersionsMenu />
          <PublishMenu />
          <div className="mx-1 h-5 w-px bg-neutral-200" />
          <button title="撤销 (Ctrl+Z)" onClick={doUndo}
            className="rounded-lg p-2 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-600">
            <Undo2 size={15} />
          </button>
          <button title="重做 (Ctrl+Shift+Z)" onClick={doRedo}
            className="rounded-lg p-2 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-600">
            <Redo2 size={15} />
          </button>
        </div>
      </header>

      {/* 主区域:左栏(页面+图层+属性,可隐藏) · 画布(全宽) · 右栏(Agent 工作区) */}
      <div className="flex min-h-0 flex-1">
        {leftPanelVisible && !focusMode ? (
          <div className="relative shrink-0">
            <LeftPanel />
            <button
              title="隐藏左栏 (Ctrl+B)"
              onClick={() => toggleLeftPanel(false)}
              className="absolute top-2 right-2 z-10 rounded-lg p-1.5 text-neutral-400 transition hover:bg-neutral-200/60 hover:text-neutral-600">
              <PanelLeftClose size={14} />
            </button>
          </div>
        ) : !focusMode ? (
          <div className="flex w-9 shrink-0 flex-col items-center gap-2 border-r border-neutral-200 bg-white py-2">
            <button
              title="展开左栏 (Ctrl+B)"
              onClick={() => toggleLeftPanel(true)}
              className="rounded-lg p-1.5 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-600">
              <PanelLeftOpen size={15} />
            </button>
            <button
              title="页面"
              onClick={() => toggleLeftPanel(true)}
              className="rounded-lg p-1.5 text-neutral-300 transition hover:bg-neutral-100 hover:text-neutral-500">
              <Layers size={14} />
            </button>
          </div>
        ) : null}
        <main className="relative min-w-0 flex-1">
          <CanvasStage />
        </main>
        {agentVisible && !focusMode && (
        <AgentPanelV2
          projectId={projectId}
          conversationId={conversationId}
          selectedChips={selectedChips}
          onOpenSettings={() => setSettingsOpen(true)}
          onCommitted={() => {
            // 提交后刷新 workspace 主数据(boards/frames/IR 文档)
            void refetchWorkspace();
          }}
        />
        )}
      </div>

      {/* 底部状态栏(文档 §2):Rev / 选中信息 / 画布缩放坐标 / 在线 / 快捷键 */}
      <footer className="flex h-7 shrink-0 items-center justify-between border-t border-neutral-200 bg-neutral-50 px-3 text-[11px] text-neutral-400">
        <div className="flex items-center gap-3">
          <span>Rev {workspaceQ2.data?.revision ?? 0}</span>
          <span>{pages.length} 个页面</span>
          <span className="max-w-[260px] truncate">选中 {selectionLabel}</span>
          <span className="tabular-nums">画布 {Math.round(canvasInfo.zoom * 100)}% · X:{canvasInfo.x} Y:{canvasInfo.y}</span>
          {focusMode && <span className="text-indigo-500">专注模式(⌘. 退出)</span>}
        </div>
        <div className="flex items-center gap-3">
          <span>⌘B 左栏</span>
          <span>⌘J Agent</span>
          <span>⌘. 专注</span>
          <span>Shift+A 排列</span>
          <span>Space 拖动 · ⌘滚轮缩放</span>
        </div>
      </footer>

      {settingsOpen && <SettingsDialog projectId={projectId} onClose={() => setSettingsOpen(false)} />}
      {importOpen && <ImportDialog projectId={projectId} onClose={() => setImportOpen(false)} />}
      {templatesOpen && <TemplatesDialog projectId={projectId} onClose={() => setTemplatesOpen(false)} />}
      {skillsOpen && <SkillsDialog onClose={() => setSkillsOpen(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 模板库(M7):保存当前项目为模板 / 市场列表 / 一键应用
// ---------------------------------------------------------------------------
function TemplatesDialog({ projectId, onClose }: { projectId: number; onClose: () => void }) {
  const utils = trpc.useUtils();
  const workspaceQ = trpc.workspace.get.useQuery({ projectId });
  const listQ = trpc.templates.list.useQuery({});
  const { user } = useAuth();
  const saveMut = trpc.templates.save.useMutation({
    onSuccess: () => { utils.templates.list.invalidate({}); setSaveName(""); toast.success("已保存为模板"); },
    onError: (e) => toast.error(e.message.slice(0, 140)),
  });
  const applyMut = trpc.templates.applyToProject.useMutation({
    onSuccess: (r) => {
      utils.workspace.get.invalidate({ projectId });
      toast.success(`已应用模板:新增 ${r.appliedSurfaces} 个页面(revision ${r.revision})`);
    },
    onError: (e) => toast.error(e.message.slice(0, 140)),
  });
  // 封面自定义(演进项 §2.1):创建者上传截图替换自动生成封面
  const setCoverMut = trpc.templates.setCover.useMutation({
    onSuccess: () => { utils.templates.list.invalidate({}); toast.success("封面已更新"); },
    onError: (e) => toast.error(e.message.slice(0, 140)),
  });
  const coverInputRef = useRef<HTMLInputElement>(null);
  const coverTargetRef = useRef<string>("");
  const pickCover = (templateId: string) => {
    coverTargetRef.current = templateId;
    coverInputRef.current?.click();
  };
  const onCoverFile = async (f: File | undefined) => {
    if (!f || !coverTargetRef.current) return;
    if (f.size > 512 * 1024) { toast.error("封面图片过大(≤512KB)"); return; }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error("封面读取失败"));
      r.readAsDataURL(f);
    });
    setCoverMut.mutate({ templateId: coverTargetRef.current, image: dataUrl });
  };
  const [saveName, setSaveName] = useState("");
  const [saveCategory, setSaveCategory] = useState("通用");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <div className="flex w-[560px] flex-col rounded-2xl bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="flex items-center gap-2 text-lg font-bold">
          <LayoutTemplate size={17} className="text-indigo-500" /> 模板库
        </h2>

        {/* 保存当前项目为模板 */}
        <div className="mt-3 flex items-center gap-2 rounded-xl border border-neutral-100 bg-neutral-50/60 p-2.5">
          <input
            value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="模板名称"
            className="min-w-0 flex-1 rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400" />
          <input
            value={saveCategory} onChange={(e) => setSaveCategory(e.target.value)} placeholder="分类"
            className="w-24 rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400" />
          <button
            disabled={!saveName.trim() || saveMut.isPending}
            onClick={() => saveMut.mutate({ projectId, name: saveName.trim(), category: saveCategory.trim() || "通用" })}
            className="flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-indigo-500 disabled:opacity-40">
            <Save size={13} /> 存为模板
          </button>
        </div>

        {/* 市场列表 */}
        <div className="mt-3 max-h-[300px] overflow-y-auto rounded-xl border border-neutral-100">
          {(listQ.data ?? []).map((t) => (
            <div key={t.templateId} className="flex items-center gap-2 border-b border-neutral-50 px-3 py-2 last:border-b-0">
              {t.hasCover ? (
                <iframe
                  src={`/api/templates/${t.templateId}/cover`}
                  title={t.name}
                  sandbox="allow-same-origin"
                  loading="lazy"
                  className="h-12 w-20 shrink-0 rounded-md border border-neutral-200 bg-white"
                />
              ) : (
                <span className="flex h-12 w-20 shrink-0 items-center justify-center rounded-md border border-neutral-200 bg-neutral-50 text-[10px] text-neutral-300">
                  无封面
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-xs font-medium text-neutral-700">{t.name}</span>
                  <span className="rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-400">{t.category}</span>
                  <span className="text-[10px] text-neutral-300">{t.surfaceCount} 页</span>
                </div>
                {t.description && <div className="truncate text-[10px] text-neutral-400">{t.description}</div>}
              </div>
              <button
                disabled={applyMut.isPending}
                onClick={() => applyMut.mutate({ projectId, baseRevision: workspaceQ.data?.revision ?? 0, templateId: t.templateId })}
                className="rounded-lg border border-indigo-200 px-2.5 py-1 text-[11px] font-medium text-indigo-600 transition hover:bg-indigo-50 disabled:opacity-40">
                应用
              </button>
              {user?.id != null && Number(t.createdBy) === user.id && (
                <button
                  onClick={() => pickCover(t.templateId)}
                  title="替换封面(上传截图)"
                  className="rounded-lg border border-neutral-200 p-1.5 text-neutral-400 transition hover:bg-neutral-50 hover:text-neutral-600">
                  <FileUp size={13} />
                </button>
              )}
            </div>
          ))}
          {listQ.data?.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-neutral-400">还没有模板;把做好的项目保存为模板,即可在任意项目中复用。</div>
          )}
        </div>

        {/* 封面上传隐藏 input(演进项:模板封面自定义) */}
        <input
          ref={coverInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={(e) => { void onCoverFile(e.target.files?.[0]); e.target.value = ""; }}
        />

        <div className="mt-4 flex justify-end">
          <button onClick={onClose} className="rounded-xl px-4 py-2 text-sm text-neutral-500 transition hover:bg-neutral-100">关闭</button>
        </div>
      </div>
    </div>
  );
}

function FullLoading() {
  return (
    <div className="flex h-screen items-center justify-center bg-neutral-50">
      <div className="flex items-center gap-2 text-sm text-neutral-400">
        <Sparkles size={16} className="animate-pulse" /> 加载工作台…
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TSX 导入(M5.3):粘贴 React TSX → 解析入 IR + Import Report
// ---------------------------------------------------------------------------
function ImportDialog({ projectId, onClose }: { projectId: number; onClose: () => void }) {
  const utils = trpc.useUtils();
  const workspaceQ = trpc.workspace.get.useQuery({ projectId });
  const importMut = trpc.imports.create.useMutation({
    onSuccess: (r) => {
      utils.workspace.get.invalidate({ projectId });
      const u = r.report.unmapped.length;
      const skipped = r.report.skippedExpressions;
      toast.success(`导入完成:revision ${r.revision},未映射 ${u} 项${skipped ? `,跳过表达式 ${skipped} 个` : ""}`);
      onClose();
    },
    onError: (e) => toast.error(e.message.slice(0, 160)),
  });
  const [files, setFiles] = useState<{ name: string; content: string }[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [pasteName, setPasteName] = useState("pasted.tsx");
  const [pasteContent, setPasteContent] = useState("");

  const MAX_FILES = 50;
  const addFiles = async (list: FileList | File[]) => {
    const next: { name: string; content: string }[] = [];
    for (const f of Array.from(list)) {
      if (!/\.(tsx|ts)$/i.test(f.name)) continue;
      if (f.size > 512 * 1024) { toast.error(`${f.name} 超过 512KB,已跳过`); continue; }
      next.push({ name: f.name, content: await f.text() });
    }
    if (!next.length) { toast.error("仅支持 .tsx/.ts 文件(≤512KB)"); return; }
    setFiles((cur) => [...cur, ...next].slice(0, MAX_FILES));
  };

  const allFiles = [
    ...files,
    ...(pasteContent.trim() ? [{ name: pasteName.trim() || "pasted.tsx", content: pasteContent }] : []),
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <div className="flex w-[560px] flex-col rounded-2xl bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="flex items-center gap-2 text-lg font-bold">
          <FileUp size={17} className="text-indigo-500" /> 导入 TSX 页面
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-neutral-400">
          拖入/选择多个 .tsx 文件,或直接粘贴代码。解析为 Design IR 并追加为新 revision,未映射的自定义组件会降级为容器并逐项标记。
        </p>

        {/* 拖拽/选择区 */}
        <label
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); void addFiles(e.dataTransfer.files); }}
          className={`mt-3 flex cursor-pointer flex-col items-center gap-1 rounded-xl border-2 border-dashed px-4 py-5 text-center transition ${
            dragOver ? "border-indigo-400 bg-indigo-50/60" : "border-neutral-200 hover:border-neutral-300"
          }`}
        >
          <FileUp size={18} className="text-neutral-400" />
          <span className="text-xs text-neutral-500">拖拽 .tsx 文件到此处,或点击选择(支持多选,≤50 个 / 单文件 512KB)</span>
          <input
            type="file" multiple accept=".tsx,.ts" className="hidden"
            onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ""; }} />
        </label>

        {/* 已选文件列表 */}
        {files.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {files.map((f, i) => (
              <span key={`${f.name}-${i}`} className="flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-600">
                {f.name}
                <button
                  onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}
                  className="text-neutral-400 transition hover:text-red-500">×</button>
              </span>
            ))}
          </div>
        )}

        {/* 粘贴方式(可选) */}
        <details className="mt-2 text-xs text-neutral-500">
          <summary className="cursor-pointer select-none">或粘贴单个文件代码</summary>
          <input
            value={pasteName} onChange={(e) => setPasteName(e.target.value)} placeholder="文件名(如 login.tsx)"
            className="mt-2 w-full rounded-lg border border-neutral-200 px-3 py-1.5 text-xs outline-none focus:border-indigo-400" />
          <textarea
            value={pasteContent} onChange={(e) => setPasteContent(e.target.value)}
            placeholder={"export default function Page() {\n  return <section>…</section>;\n}"}
            rows={6}
            className="mt-2 w-full resize-none rounded-lg border border-neutral-200 px-3 py-2 font-mono text-xs outline-none focus:border-indigo-400" />
        </details>

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-xl px-4 py-2 text-sm text-neutral-500 transition hover:bg-neutral-100">取消</button>
          <button
            disabled={allFiles.length === 0 || importMut.isPending}
            onClick={() => importMut.mutate({ projectId, baseRevision: workspaceQ.data?.revision ?? 0, files: allFiles })}
            className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-40">
            {importMut.isPending ? `导入中(${allFiles.length} 个文件)…` : `导入 ${allFiles.length || ""} 个文件`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skill 市场(M7-6 前端):浏览已批准 / 提交第三方 / 审核 submitted(§24.7 审核流)
// ---------------------------------------------------------------------------
interface SkillMarketItem {
  skillId: string;
  enabled?: boolean;
  manifest: {
    id?: string;
    name?: string;
    version?: string;
    publisher?: string;
    trust?: string;
    description?: string;
    triggers?: { keywords?: string[] };
  };
}

function SkillsDialog({ onClose }: { onClose: () => void }) {
  const tutils = trpc.useUtils();
  const listQ = trpc.skills.list.useQuery();
  const reviewQ = trpc.skills.reviewList.useQuery();
  const submitMut = trpc.skills.submit.useMutation({
    onSuccess: (r) => {
      toast.success(`Skill「${r.skillId}」已提交,等待审核`);
      setManifest("");
      void tutils.skills.reviewList.invalidate();
    },
    onError: (e) => toast.error(e.message.slice(0, 160)),
  });
  const approveMut = trpc.skills.approve.useMutation({
    onSuccess: (_r, vars) => {
      toast.success(`Skill「${vars.skillId}」已通过审核并启用`);
      void tutils.skills.list.invalidate();
      void tutils.skills.reviewList.invalidate();
    },
    onError: (e) => toast.error(e.message.slice(0, 140)),
  });
  const rejectMut = trpc.skills.reject.useMutation({
    onSuccess: (_r, vars) => {
      toast.info(`Skill「${vars.skillId}」已拒绝`);
      void tutils.skills.reviewList.invalidate();
    },
    onError: (e) => toast.error(e.message.slice(0, 140)),
  });
  const [manifest, setManifest] = useState("");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <div className="flex max-h-[80vh] w-[620px] flex-col rounded-2xl bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="flex items-center gap-2 text-lg font-bold">
          <Sparkles size={17} className="text-violet-500" /> Skill 市场
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-neutral-400">
          Skill 是可插拔的 UI/UX 专家能力包(§24)。第三方 Skill 提交后经沙箱校验进入待审核;审核通过才进入 Agent 自动路由池(每 Run 最多 3 个)。
        </p>

        <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
          {/* 已批准 */}
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-neutral-400">已启用({listQ.data?.length ?? 0})</div>
          {(listQ.data ?? []).map((s: SkillMarketItem) => (
            <div key={s.skillId} className="mb-1.5 rounded-lg border border-neutral-100 p-2.5">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-xs font-medium text-neutral-700">{s.manifest.name ?? s.skillId}</span>
                <span className="rounded-full bg-neutral-100 px-1.5 py-0.5 text-[9px] text-neutral-400">v{s.manifest.version ?? "1.0.0"}</span>
                <span className={`rounded-full px-1.5 py-0.5 text-[9px] ${s.manifest.trust === "official" ? "bg-indigo-50 text-indigo-500" : "bg-amber-50 text-amber-600"}`}>
                  {s.manifest.trust ?? "third_party"}
                </span>
                <span className="ml-auto text-[10px] text-neutral-300">{s.manifest.publisher}</span>
              </div>
              <div className="mt-1 text-[10px] leading-relaxed text-neutral-400">{s.manifest.description}</div>
              {!!s.manifest.triggers?.keywords?.length && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {s.manifest.triggers.keywords.slice(0, 5).map((k) => (
                    <span key={k} className="rounded-full bg-violet-500/10 px-1.5 py-0.5 text-[9px] text-violet-600">{k}</span>
                  ))}
                </div>
              )}
            </div>
          ))}

          {/* 待审核(§24.7 审核流) */}
          {(reviewQ.data ?? []).length > 0 && (
            <>
              <div className="mb-1 mt-3 text-[10px] font-medium uppercase tracking-wide text-neutral-400">待审核({reviewQ.data?.length})</div>
              {(reviewQ.data ?? []).map((s) => {
                const m = s.manifest as SkillMarketItem["manifest"];
                const createdBy = s.createdBy != null ? String(s.createdBy) : "?";
                return (
                <div key={s.skillId} className="mb-1.5 rounded-lg border border-amber-200 bg-amber-50/40 p-2.5">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-xs font-medium text-neutral-700">{m.name ?? s.skillId}</span>
                    <span className="text-[10px] text-neutral-400">{`提交人 #${createdBy}`}</span>
                    <div className="ml-auto flex gap-1.5">
                      <button
                        onClick={() => approveMut.mutate({ skillId: s.skillId })}
                        disabled={approveMut.isPending}
                        className="rounded-md bg-emerald-600 px-2.5 py-1 text-[10px] font-medium text-white transition hover:bg-emerald-500 disabled:opacity-40">
                        通过并启用
                      </button>
                      <button
                        onClick={() => { if (confirm(`拒绝 Skill「${s.skillId}」?`)) rejectMut.mutate({ skillId: s.skillId }); }}
                        disabled={rejectMut.isPending}
                        className="rounded-md border px-2.5 py-1 text-[10px] text-neutral-500 transition hover:bg-neutral-100 disabled:opacity-40">
                        拒绝
                      </button>
                    </div>
                  </div>
                  <div className="mt-1 text-[10px] leading-relaxed text-neutral-400">{String(m.description ?? "")}</div>
                </div>
                );
              })}
            </>
          )}
          {listQ.data?.length === 0 && <div className="px-3 py-6 text-center text-xs text-neutral-400">还没有已启用的 Skill</div>}
        </div>

        {/* 提交第三方 Skill */}
        <div className="mt-3 shrink-0 border-t border-neutral-100 pt-3">
          <textarea
            value={manifest}
            onChange={(e) => setManifest(e.target.value)}
            rows={3}
            placeholder={'粘贴 Skill manifest YAML/JSON(id/name/version/triggers/permissions…);硬性约束:commitDesign 与 network 必须为 false'}
            className="w-full resize-none rounded-lg border border-neutral-200 p-2 font-mono text-[11px] outline-none focus:border-indigo-400"
          />
          <div className="mt-2 flex justify-end gap-2">
            <button onClick={onClose} className="rounded-xl px-4 py-2 text-sm text-neutral-500 transition hover:bg-neutral-100">关闭</button>
            <button
              disabled={!manifest.trim() || submitMut.isPending}
              onClick={() => submitMut.mutate({ manifest: manifest.trim() })}
              className="flex items-center gap-1 rounded-xl bg-violet-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-violet-500 disabled:opacity-40">
              <Save size={13} /> {submitMut.isPending ? "校验提交中…" : "提交 Skill(经沙箱校验)"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LLM 设置对话框
// ---------------------------------------------------------------------------
function SettingsDialog({ projectId, onClose }: { projectId: number; onClose: () => void }) {
  const utils = trpc.useUtils();
  const settingsQ = trpc.settings.get.useQuery();
  const updateMut = trpc.settings.update.useMutation({
    onSuccess: () => { utils.settings.get.invalidate(); onClose(); },
  });

  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.moonshot.cn/v1");
  const [model, setModel] = useState("kimi-k3");
  /** 图片对话能力:auto 按模型名自动判定 / on 强制开启 / off 关闭 */
  const [vision, setVision] = useState<"auto" | "on" | "off">("auto");
  /** M6-2 预算:用户级累计成本上限(USD);0=系统默认 */
  const [budget, setBudget] = useState("0");
  /** M7 多模型路由:按阶段覆盖模型(空 = 用主模型) */
  const [pmPlanning, setPmPlanning] = useState("");
  const [pmGeneration, setPmGeneration] = useState("");
  const [pmReview, setPmReview] = useState("");
  const [loaded, setLoaded] = useState(false);

  // 设置数据到达后在渲染期同步表单(adjust-state-during-render,避免 effect 级联渲染)
  if (settingsQ.data && !loaded) {
    setLoaded(true);
    setBaseUrl(settingsQ.data.baseUrl);
    setModel(settingsQ.data.model);
    setVision(settingsQ.data.vision ?? "auto");
    setBudget(String(settingsQ.data.budgetMaxCostUsd ?? 0));
    setPmPlanning(settingsQ.data.profileModels?.planning ?? "");
    setPmGeneration(settingsQ.data.profileModels?.generation ?? "");
    setPmReview(settingsQ.data.profileModels?.review ?? "");
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={onClose}>
      {/* 内容超视口时表单区内部滚动(标题/操作条固定),不再上下截断 */}
      <div className="flex max-h-[85vh] w-[460px] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="shrink-0 px-6 pt-6">
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <Sparkles size={17} className="text-indigo-500" /> 生成引擎设置
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-neutral-400">
            页面内容由大模型真实生成并流式渲染到画布。支持任意 OpenAI 兼容服务(Kimi / DeepSeek / GPT 等),填入 API Key 即可开始。
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">
        <div className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-neutral-400">
              API Key(在对应服务商控制台创建)
            </span>
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
              placeholder={settingsQ.data?.hasApiKey ? `已保存 ${settingsQ.data.apiKeyHint}(留空则不修改)` : "sk-…"}
              className="rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-indigo-400" />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-neutral-400">Base URL</span>
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
                className="rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-indigo-400" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-neutral-400">模型</span>
              <input value={model} onChange={(e) => setModel(e.target.value)}
                className="rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-indigo-400" />
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-neutral-400">图片对话(Vision)</span>
            <select value={vision} onChange={(e) => setVision(e.target.value as "auto" | "on" | "off")}
              className="rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400">
              <option value="auto">自动(按模型判定)</option>
              <option value="on">开启(模型支持图片输入)</option>
              <option value="off">关闭(对话不使用图片)</option>
            </select>
            <span className="text-[11px] leading-relaxed text-neutral-400">
              {vision === "off"
                ? "已关闭:对话入口不显示图片附件,粘贴图片会被忽略。"
                : vision === "on"
                  ? "已开启:对话中可附加最多 3 张参考图。"
                  : settingsQ.data?.supportsImages
                    ? "自动判定:当前模型支持图片,对话中可附加参考图。"
                    : "自动判定:当前模型不支持图片,对话将不使用图片。"}
            </span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-neutral-400">预算上限(USD,累计成本;0=系统默认)</span>
            <input type="number" min={0} step={1} value={budget} onChange={(e) => setBudget(e.target.value)}
              className="rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-indigo-400" />
            <span className="text-[11px] leading-relaxed text-neutral-400">
              达到上限后 Agent 将拒绝发起新任务(run.failed: budget_exceeded),不会中断进行中的任务。
            </span>
          </label>
          <details className="rounded-lg border border-neutral-100 px-3 py-2">
            <summary className="cursor-pointer select-none text-[11px] text-neutral-400">多模型路由(高级):按阶段覆盖模型,空 = 用主模型</summary>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {[
                { label: "规划", value: pmPlanning, set: setPmPlanning },
                { label: "生成", value: pmGeneration, set: setPmGeneration },
                { label: "评审", value: pmReview, set: setPmReview },
              ].map((f) => (
                <label key={f.label} className="flex flex-col gap-1">
                  <span className="text-[10px] text-neutral-400">{f.label}</span>
                  <input value={f.value} onChange={(e) => f.set(e.target.value)} placeholder="主模型"
                    className="rounded-lg border border-neutral-200 px-2 py-1.5 text-xs outline-none focus:border-indigo-400" />
                </label>
              ))}
            </div>
          </details>
        </div>

        <BudgetUsage />

        {/* §10.5 项目记忆:用户长期偏好(查看/编辑/删除;Agent 只读注入) */}
        <PreferencesBlock />

        <LlmStats projectId={projectId} />
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-neutral-100 px-6 py-3">
          <button onClick={onClose} className="rounded-xl px-4 py-2 text-sm text-neutral-500 transition hover:bg-neutral-100">取消</button>
          <button
            disabled={updateMut.isPending || (!apiKey.trim() && !settingsQ.data?.hasApiKey)}
            onClick={() => updateMut.mutate({
              provider: "kimi",
              apiKey: apiKey.trim(),
              baseUrl: baseUrl.trim(),
              model: model.trim(),
              vision,
              budgetMaxCostUsd: Math.max(0, Number(budget) || 0),
              profileModels: {
                planning: pmPlanning.trim(),
                generation: pmGeneration.trim(),
                review: pmReview.trim(),
              },
            })}
            className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-40">
            {updateMut.isPending ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 用户级预算用量(M6-2):累计 token / 估算成本 / 预算上限
// ---------------------------------------------------------------------------
function BudgetUsage() {
  const usageQ = trpc.settings.usage.useQuery();
  const u = usageQ.data;
  if (!u) return null;
  const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const pct = u.budgetMaxCostUsd > 0 ? Math.min(100, Math.round((u.estCostUsd / u.budgetMaxCostUsd) * 100)) : 0;
  const nearLimit = pct >= 80;

  return (
    <div className="mt-4 rounded-xl border border-neutral-100 bg-neutral-50/60 p-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-neutral-500">预算用量(账户累计)</span>
        <span className={`text-[10px] tabular-nums ${nearLimit ? "text-amber-500" : "text-neutral-300"}`}>
          ${u.estCostUsd.toFixed(2)} / {u.budgetMaxCostUsd > 0 ? `$${u.budgetMaxCostUsd.toFixed(2)}` : "不限"}
        </span>
      </div>
      {u.budgetMaxCostUsd > 0 && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-neutral-200">
          <div
            className={`h-full rounded-full transition-all ${nearLimit ? "bg-amber-500" : "bg-indigo-500"}`}
            style={{ width: `${pct}%` }} />
        </div>
      )}
      <div className="mt-2 text-[10px] text-neutral-400 tabular-nums">
        输入 {fmtTokens(u.promptTokens)} tok · 输出 {fmtTokens(u.completionTokens)} tok
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 项目记忆(§10.5):用户长期偏好,Agent 只读注入;设置页查看/编辑/删除
// ---------------------------------------------------------------------------
interface MemoryForm {
  preferredDensity?: "compact" | "comfortable" | "spacious";
  preferredTone?: string;
  colorPreferences: string[];
  componentPreferences: string[];
  forbiddenPatterns: string[];
  notes?: string;
}

function PreferencesBlock() {
  const tutils = trpc.useUtils();
  const memQ = trpc.memory.get.useQuery();
  const [form, setForm] = useState<MemoryForm | null>(null);
  // 数据到达后同步表单(渲染期调整,避免 effect 内 setState)
  if (memQ.data && form === null) {
    setForm({
      preferredDensity: memQ.data.memory.preferredDensity,
      preferredTone: memQ.data.memory.preferredTone ?? "",
      colorPreferences: memQ.data.memory.colorPreferences ?? [],
      componentPreferences: memQ.data.memory.componentPreferences ?? [],
      forbiddenPatterns: memQ.data.memory.forbiddenPatterns ?? [],
      notes: memQ.data.memory.notes ?? "",
    });
  }
  const saveMut = trpc.memory.update.useMutation({
    onSuccess: () => {
      toast.success("项目记忆已保存,后续生成将自动遵循");
      void tutils.memory.get.invalidate();
    },
    onError: (e) => toast.error(e.message.slice(0, 140)),
  });

  if (!form) return null;
  const listInput = (key: "colorPreferences" | "componentPreferences" | "forbiddenPatterns", placeholder: string) => (
    <input
      value={form[key].join(", ")}
      onChange={(e) =>
        setForm({ ...form, [key]: e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean).slice(0, 12) })
      }
      placeholder={placeholder}
      className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-indigo-400"
    />
  );

  return (
    <div className="mt-4 rounded-xl border border-neutral-100 bg-neutral-50/60 p-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-neutral-500">项目记忆(§10.5 · Agent 生成时自动遵循)</span>
        <button
          disabled={saveMut.isPending}
          onClick={() =>
            saveMut.mutate({
              memory: {
                preferredDensity: form.preferredDensity,
                preferredTone: form.preferredTone?.trim() || undefined,
                colorPreferences: form.colorPreferences,
                componentPreferences: form.componentPreferences,
                forbiddenPatterns: form.forbiddenPatterns,
                notes: form.notes?.trim() || undefined,
              },
            })
          }
          className="rounded-lg bg-indigo-600 px-2.5 py-1 text-[10px] font-medium text-white transition hover:bg-indigo-500 disabled:opacity-40">
          {saveMut.isPending ? "保存中…" : "保存记忆"}
        </button>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-neutral-400">信息密度偏好</span>
          <select
            value={form.preferredDensity ?? ""}
            onChange={(e) => setForm({ ...form, preferredDensity: (e.target.value || undefined) as MemoryForm["preferredDensity"] })}
            className="rounded-lg border border-neutral-200 px-2 py-1.5 text-xs outline-none focus:border-indigo-400">
            <option value="">未设置</option>
            <option value="compact">紧凑</option>
            <option value="comfortable">舒适</option>
            <option value="spacious">宽松</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-neutral-400">语气/调性</span>
          <input
            value={form.preferredTone ?? ""}
            onChange={(e) => setForm({ ...form, preferredTone: e.target.value })}
            placeholder="如:专业克制"
            className="rounded-lg border border-neutral-200 px-2 py-1.5 text-xs outline-none focus:border-indigo-400"
          />
        </label>
      </div>
      <div className="mt-2 space-y-1.5">
        {listInput("colorPreferences", "色彩偏好(逗号分隔,如:深蓝,灰绿)")}
        {listInput("componentPreferences", "组件偏好(逗号分隔)")}
        {listInput("forbiddenPatterns", "禁止使用(逗号分隔,如:渐变滥用,弹窗堆叠)")}
        <textarea
          value={form.notes ?? ""}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
          rows={2}
          placeholder="其他偏好说明…"
          className="w-full resize-none rounded-lg border border-neutral-200 px-3 py-2 text-xs outline-none focus:border-indigo-400"
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LLM 用量统计(设置对话框内):聚合指标 + 最近调用明细
// ---------------------------------------------------------------------------
function LlmStats({ projectId }: { projectId: number }) {
  const statsQ = trpc.stats.overview.useQuery({ projectId });
  const data = statsQ.data;
  if (!data || !data.totals.calls) return null;
  const t = data.totals;
  const successRate = Math.round(((t.calls - t.failures) / t.calls) * 100);
  const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

  return (
    <div className="mt-4 rounded-xl border border-neutral-100 bg-neutral-50/60 p-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-neutral-500">生成用量统计</span>
        <span className="text-[10px] text-neutral-300">本项目累计</span>
      </div>
      <div className="mt-2 grid grid-cols-4 gap-1.5 text-center">
        {[
          { label: "调用", value: `${t.calls} 次` },
          { label: "成功率", value: `${successRate}%` },
          { label: "平均耗时", value: `${(t.avgMs / 1000).toFixed(1)}s` },
          { label: "Tokens", value: `${fmtTokens(t.promptTokens)}+${fmtTokens(t.completionTokens)}` },
        ].map((m) => (
          <div key={m.label} className="rounded-lg bg-white px-1 py-1.5">
            <div className="text-xs font-semibold tabular-nums text-neutral-700">{m.value}</div>
            <div className="mt-0.5 text-[10px] text-neutral-400">{m.label}</div>
          </div>
        ))}
      </div>
      {data.recent.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          {data.recent.slice(0, 5).map((c) => (
            <div key={c.id} className="flex items-center gap-2 text-[10px] text-neutral-400">
              <span className={c.success ? "text-emerald-500" : "text-red-400"}>{c.success ? "●" : "●"}</span>
              <span className="w-14 shrink-0">{c.kind === "ops" ? "元素补丁" : "整页生成"}</span>
              <span className="w-16 shrink-0 truncate">{engineDisplayName(c.provider, c.model)}</span>
              <span className="tabular-nums">{(c.durationMs / 1000).toFixed(1)}s</span>
              <span className="tabular-nums">{fmtTokens(c.promptTokens)}+{fmtTokens(c.completionTokens)} tok</span>
              <span className="ml-auto">{new Date(c.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
