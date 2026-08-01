/**
 * 工作台:顶栏 + 左页面栏 + 画布 + 右检查器 + 底部悬浮对话框
 */
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  ArrowLeft, Layers, PanelLeftClose, PanelLeftOpen, Redo2, Undo2, Sparkles,
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useUndoRedo } from "@/hooks/useUndoRedo";
import { trpc } from "@/providers/trpc";
import { useWorkspace } from "@/stores/workspaceStore";
import { CanvasStage } from "@/components/canvas/CanvasStage";
import { LeftPanel } from "@/components/panels/LeftPanel";
import { AgentPanel } from "@/components/agent/AgentPanel";
import { PublishMenu } from "@/components/panels/PublishMenu";
import { VersionsMenu } from "@/components/panels/VersionsMenu";
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

  const projectQ = trpc.projects.get.useQuery({ id: projectId }, { enabled: !!user && !!projectId });
  const updateProjectMut = trpc.projects.update.useMutation();

  // 左栏显隐切换后,画布容器尺寸变化需重测
  const toggleLeftPanel = (v: boolean) => {
    setLeftPanelVisible(v);
    setTimeout(() => (window as unknown as { __resizeCanvas?: () => void }).__resizeCanvas?.(), 120);
  };

  // 初始化 store
  useEffect(() => {
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
  }, [projectQ.data?.id]);

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
    <div className="flex h-screen flex-col overflow-hidden bg-white">
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

      {/* 主区域:左栏(页面+图层+属性,可隐藏) · 画布(全宽) · 右栏(Agent 对话) */}
      <div className="flex min-h-0 flex-1">
        {leftPanelVisible ? (
          <div className="relative shrink-0">
            <LeftPanel />
            <button
              title="隐藏左栏 (Ctrl+B)"
              onClick={() => toggleLeftPanel(false)}
              className="absolute top-2 right-2 z-10 rounded-lg p-1.5 text-neutral-400 transition hover:bg-neutral-200/60 hover:text-neutral-600">
              <PanelLeftClose size={14} />
            </button>
          </div>
        ) : (
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
        )}
        <main className="relative min-w-0 flex-1">
          <CanvasStage />
        </main>
        <AgentPanel onOpenSettings={() => setSettingsOpen(true)} />
      </div>

      {settingsOpen && <SettingsDialog projectId={projectId} onClose={() => setSettingsOpen(false)} />}
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
  const [loaded, setLoaded] = useState(false);

  // 设置数据到达后在渲染期同步表单(adjust-state-during-render,避免 effect 级联渲染)
  if (settingsQ.data && !loaded) {
    setLoaded(true);
    setBaseUrl(settingsQ.data.baseUrl);
    setModel(settingsQ.data.model);
    setVision(settingsQ.data.vision ?? "auto");
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <div className="w-[460px] rounded-2xl bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="flex items-center gap-2 text-lg font-bold">
          <Sparkles size={17} className="text-indigo-500" /> 生成引擎设置
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-neutral-400">
          页面内容由大模型真实生成并流式渲染到画布。支持任意 OpenAI 兼容服务(Kimi / DeepSeek / GPT 等),填入 API Key 即可开始。
        </p>

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
        </div>

        <LlmStats projectId={projectId} />

        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-xl px-4 py-2 text-sm text-neutral-500 transition hover:bg-neutral-100">取消</button>
          <button
            disabled={updateMut.isPending || (!apiKey.trim() && !settingsQ.data?.hasApiKey)}
            onClick={() => updateMut.mutate({ provider: "kimi", apiKey: apiKey.trim(), baseUrl: baseUrl.trim(), model: model.trim(), vision })}
            className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-40">
            {updateMut.isPending ? "保存中…" : "保存"}
          </button>
        </div>
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
