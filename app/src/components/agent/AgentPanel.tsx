/**
 * 右侧 Harness Agent 面板(Codex 风格)
 * - SSE 流式生成:执行步骤实时推送,结论打字机输出,可随时停止
 * - Turn 执行轨迹:思考行 + 工具调用卡(args/result 同卡) + 计划审批卡 + 结论内联操作
 * - Auto / Build / Plan 三模式:Auto 按变更风险自动判断是否先出计划审批
 * - 智能滚动:贴底时自动跟随;用户上翻时不打扰,提供"回到底部"
 */
import { useEffect, useRef, useState } from "react";
import {
  ArrowDown, ArrowUp, Bot, ImagePlus, Layers, MessageSquare, MousePointer2,
  Settings2, Sparkles, Square, Trash2, X,
} from "lucide-react";
import { toast } from "sonner";
import { useWorkspace, type ChatMessage, type PageState } from "@/stores/workspaceStore";
import { streamChatGenerate } from "@/lib/chatStream";
import { parsePartialPages } from "@/lib/partialSurface";
import { MAX_IMAGES, fileToPendingImage, type PendingImage } from "@/lib/image";
import { trpc } from "@/providers/trpc";
import type { ChatAction, ChatStep, ContextChip } from "@contracts/a2ui";
import { DEFAULT_TOKENS, DEVICES, engineDisplayName } from "@contracts/a2ui";
import { QUICK_PROMPTS } from "./constants";
import { MessageItem } from "./MessageItem";
import { ConversationList } from "./ConversationList";

let msgSeq = 0;
const nextMsgId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++msgSeq}`;

/** 生成完成后自动定位受影响页面:新建时聚焦本批第一个新页面(流式期间已逐页跟随,
 *  完成后回到起点便于从头查看);否则定位被编辑的目标页(ops/整页重生成)。
 *  页面落库与流式草稿清理存在时序差,短延时 + 重试兜底,避免静默丢失聚焦 */
function focusAffectedPage(actions: ChatAction[], appliedPages: { id: number }[]) {
  let id: number | undefined;
  if (actions.some((a) => a.type === "createPage")) {
    id = appliedPages[0]?.id;
  } else {
    const edited = [...actions].reverse().find((a) => a.type === "updateSurface" || a.type === "ops");
    if (edited && "pageId" in edited) id = Number(edited.pageId);
  }
  if (id == null || Number.isNaN(id)) return;
  const target = id;
  const tryFocus = (attempt: number) => {
    const landed = useWorkspace.getState().pages.some((p) => p.id === target);
    if (!landed && attempt < 4) {
      setTimeout(() => tryFocus(attempt + 1), 250);
      return;
    }
    (window as unknown as { __focusPage?: (x: number) => void }).__focusPage?.(target);
  };
  setTimeout(() => tryFocus(0), 150);
}

export function AgentPanel({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [input, setInput] = useState("");
  /** 待发送的参考图片(客户端已压缩) */
  const [images, setImages] = useState<PendingImage[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const stickToBottomRef = useRef(true);
  const abortRef = useRef<(() => void) | null>(null);
  const revealTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const projectId = useWorkspace((s) => s.projectId);
  const generating = useWorkspace((s) => s.generating);
  const setGenerating = useWorkspace((s) => s.setGenerating);
  const messages = useWorkspace((s) => s.messages);
  const pushMessage = useWorkspace((s) => s.pushMessage);
  const updateMessage = useWorkspace((s) => s.updateMessage);
  const snapshotForUndo = useWorkspace((s) => s.snapshotForUndo);
  const applyActions = useWorkspace((s) => s.applyActions);
  const setDraft = useWorkspace((s) => s.setDraft);
  const selectedElements = useWorkspace((s) => s.selectedElements);
  const selectedPageIds = useWorkspace((s) => s.selectedPageIds);
  const chips = useWorkspace((s) => s.chips);
  const setSelectedElements = useWorkspace((s) => s.setSelectedElements);
  const setSelectedPages = useWorkspace((s) => s.setSelectedPages);

  const [showJump, setShowJump] = useState(false);
  const [showConvList, setShowConvList] = useState(false);
  const conversationId = useWorkspace((s) => s.conversationId);

  // 面板宽度:左缘拖拽调整(280~560px),持久化到 localStorage
  const [panelWidth, setPanelWidth] = useState(() => {
    const saved = typeof localStorage !== "undefined" ? localStorage.getItem("a2.agentWidth") : null;
    const n = saved ? parseInt(saved, 10) : NaN;
    return Number.isNaN(n) ? 380 : Math.min(560, Math.max(280, n));
  });
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    try { localStorage.setItem("a2.agentWidth", String(panelWidth)); } catch { /* ignore */ }
  }, [panelWidth]);

  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => {
      setPanelWidth(Math.min(560, Math.max(280, window.innerWidth - e.clientX)));
    };
    const onUp = () => {
      setResizing(false);
      // 面板宽度变化后画布容器尺寸变化,需重测
      (window as unknown as { __resizeCanvas?: () => void }).__resizeCanvas?.();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [resizing]);

  const utils = trpc.useUtils();
  const settingsQ = trpc.settings.get.useQuery();
  const applyPlanMut = trpc.chat.applyPlan.useMutation();
  const clearChatMut = trpc.chat.clear.useMutation({
    onSuccess: () => {
      useWorkspace.getState().setMessages([]);
      utils.chat.history.invalidate();
    },
  });

  /** 清空会话历史(二次确认,防止误删) */
  const clearHistory = () => {
    if (!projectId || !messages.length) return;
    if (!window.confirm("确定清空当前项目的全部会话历史吗?画布上的页面不受影响。")) return;
    clearChatMut.mutate({ projectId });
  };

  // 卸载时中止未完成的流与打字机
  useEffect(() => () => {
    abortRef.current?.();
    if (revealTimerRef.current) clearInterval(revealTimerRef.current);
  }, []);

  // 历史消息装载(项目切换时装最近会话)
  useEffect(() => {
    if (!projectId) return;
    stickToBottomRef.current = true;
    utils.chat.history.fetch({ projectId }).then((h) => {
      if (!h) return;
      const msgs: ChatMessage[] = h.messages.map((m) => {
        let meta: { chips?: ContextChip[]; engine?: string; model?: string; steps?: ChatStep[]; images?: string[] } = {};
        try { meta = m.meta ? JSON.parse(m.meta) : {}; } catch { /* ignore */ }
        return {
          id: String(m.id),
          role: m.role === "user" ? "user" : "assistant",
          content: m.content,
          chips: meta.chips,
          images: meta.images,
          engine: meta.engine,
          model: meta.model,
          steps: meta.steps,
        };
      });
      const st = useWorkspace.getState();
      st.setMessages(msgs);
      st.setConversationId(h.conversationId ?? null);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  /** 切换到指定会话(装载其消息) */
  const switchConversation = (id: number) => {
    if (!projectId) return;
    utils.chat.history.fetch({ projectId, conversationId: id }).then((h) => {
      if (!h) return;
      const msgs: ChatMessage[] = h.messages.map((m) => {
        let meta: { chips?: ContextChip[]; engine?: string; model?: string; steps?: ChatStep[]; images?: string[] } = {};
        try { meta = m.meta ? JSON.parse(m.meta) : {}; } catch { /* ignore */ }
        return {
          id: String(m.id),
          role: m.role === "user" ? "user" : "assistant",
          content: m.content,
          chips: meta.chips,
          images: meta.images,
          engine: meta.engine,
          model: meta.model,
          steps: meta.steps,
        };
      });
      const st = useWorkspace.getState();
      st.setMessages(msgs);
      st.setConversationId(id);
      stickToBottomRef.current = true;
    }).catch(() => {});
  };

  /** 新建会话:清空面板,首次发送时后端自动建档 */
  const newConversation = () => {
    const st = useWorkspace.getState();
    st.setMessages([]);
    st.setConversationId(null);
    setShowConvList(false);
    inputRef.current?.focus();
  };

  // 智能滚动:贴底时跟随最新消息;用户上翻时显示"回到底部"
  const lastMsg = messages[messages.length - 1];
  const lastUpdateKey = `${messages.length}:${lastMsg?.content.length ?? 0}:${lastMsg?.steps?.length ?? 0}`;
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (stickToBottomRef.current) {
      el.scrollTo({ top: el.scrollHeight });
    } else {
      setShowJump(true);
    }
  }, [lastUpdateKey]);

  const onListScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickToBottomRef.current = nearBottom;
    if (nearBottom) setShowJump(false);
  };

  const jumpToBottom = () => {
    stickToBottomRef.current = true;
    setShowJump(false);
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  };

  // 选中元素后聚焦输入框
  useEffect(() => {
    if (selectedElements.length) inputRef.current?.focus();
  }, [selectedElements]);

  const allChips = chips();

  const removeChip = (chip: ContextChip) => {
    if (chip.kind === "element") {
      // 多选:只移除对应的组件
      setSelectedElements(selectedElements.filter((el) => !(String(el.pageId) === chip.pageId && el.aid === chip.aid)));
    } else {
      setSelectedPages(selectedPageIds.filter((id) => String(id) !== chip.pageId));
    }
  };

  /** 打字机输出结论文本 */
  const revealText = (id: string, full: string) => {
    if (revealTimerRef.current) clearInterval(revealTimerRef.current);
    if (!full) {
      updateMessage(id, { content: "", streaming: false });
      return;
    }
    const step = Math.max(2, Math.ceil(full.length / 36));
    let i = 0;
    revealTimerRef.current = setInterval(() => {
      i = Math.min(full.length, i + step);
      const done = i >= full.length;
      updateMessage(id, { content: full.slice(0, i), streaming: !done });
      if (done && revealTimerRef.current) {
        clearInterval(revealTimerRef.current);
        revealTimerRef.current = null;
      }
    }, 24);
  };

  const stop = () => {
    abortRef.current?.();
    abortRef.current = null;
  };

  /** 添加参考图片(按钮 / 粘贴共用);超限与非法类型给出明确提示 */
  const addImages = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    if (list.length + images.length > MAX_IMAGES) toast.error(`最多附带 ${MAX_IMAGES} 张参考图片`);
    for (const f of list.slice(0, Math.max(0, MAX_IMAGES - images.length))) {
      try {
        const img = await fileToPendingImage(f);
        setImages((prev) => [...prev, img]);
      } catch (e) {
        toast.error((e as Error).message);
      }
    }
  };

  const send = async (text?: string) => {
    const prompt = (text ?? input).trim();
    if (!prompt || !projectId || generating) return;
    // 模型不支持图片对话时前端已拦截入口;这里再兜底一次,绝不把图片发给纯文本模型
    const sending = supportsImages ? images : [];
    setInput("");
    setImages([]);
    snapshotForUndo();
    pushMessage({
      id: nextMsgId("u"), role: "user", content: prompt, chips: allChips,
      images: sending.length ? sending.map((i) => i.dataUrl) : undefined,
    });
    const pendingId = nextMsgId("a");
    pushMessage({ id: pendingId, role: "assistant", content: "", pending: true, steps: [] });
    setGenerating(true);
    stickToBottomRef.current = true;

    const stepsBuf: ChatStep[] = [];
    // 草稿节流(服务端已 150ms 节流,这里再兜底一次避免解析过于频繁)
    let lastDraftAt = 0;
    // 服务端推增量 delta,本地累加还原全量文本后做容错解析
    let draftText = "";
    const { promise, abort } = streamChatGenerate(
      {
        projectId, prompt, chips: allChips,
        conversationId: useWorkspace.getState().conversationId,
        images: sending.length ? sending.map(({ name, mediaType, data }) => ({ name, mediaType, data })) : undefined,
        imageThumbs: sending.length ? sending.map((i) => i.thumb) : undefined,
      },
      {
        onStep: (s) => {
          // 带 id 的步骤原位更新(running → done/error),无 id 纯追加
          const idx = s.id ? stepsBuf.findIndex((x) => x.id === s.id) : -1;
          if (idx >= 0) stepsBuf[idx] = s; else stepsBuf.push(s);
          updateMessage(pendingId, { steps: [...stepsBuf] });
        },
        onDraft: (d) => {
          draftText += d.delta;
          const now = Date.now();
          if (now - lastDraftAt < 120) return;
          lastDraftAt = now;
          const ws = useWorkspace.getState();
          const docs = parsePartialPages(draftText, { preset: ws.preset, device: "desktop" });
          if (d.mode === "edit" && d.pageId) {
            // 编辑重生成:在目标画框内就地渐进预览(doc 为 null 时显示微光遮罩)
            setDraft({ ghosts: [], targetPageId: Number(d.pageId), surface: docs[0] ?? null });
            return;
          }
          // 新建页面(支持多页流式):草稿事件一到就放幻影画框,多页时逐页右排;
          // 某页还没有完整组件时显示骨架屏
          const maxX = ws.pages.reduce((m, p) => Math.max(m, p.posX + p.width), 0);
          let cursorX = maxX ? maxX + 160 : 0;
          const ghosts: PageState[] = docs.map((doc, i) => {
            const device = doc?.page.device ?? "desktop";
            const dims = DEVICES[device] ?? DEVICES.desktop;
            const ghost: PageState = {
              id: -(i + 1),
              projectId,
              title: doc?.page.title || "生成中…",
              device,
              surface: doc ?? {
                version: "1.0",
                page: { id: "draft", title: "生成中…", device },
                theme: { preset: ws.preset, tokens: DEFAULT_TOKENS },
                components: {},
                root: "draft",
              },
              posX: cursorX,
              posY: 0,
              width: dims.width,
              height: dims.height,
            };
            cursorX += dims.width + 160;
            return ghost;
          });
          setDraft({ ghosts, targetPageId: null, surface: docs.find((x) => x) ?? null });
        },
      },
    );
    abortRef.current = abort;

    try {
      const { result, plan, appliedPages, conversationId: convId } = await promise;
      abortRef.current = null;
      setDraft(null);
      if (convId != null) useWorkspace.getState().setConversationId(convId);

      if (plan) {
        // Plan 模式:挂起等待审批,不应用
        updateMessage(pendingId, {
          pending: false,
          engine: result.engine,
          model: result.model,
          steps: result.steps,
          plan: { ...plan, status: "proposed" },
          planActions: result.actions,
          planPrompt: prompt,
        });
        revealText(pendingId, result.assistantText);
        return;
      }
      applyActions(
        result.actions,
        appliedPages.map((p) => ({
          id: p.id, projectId: p.projectId, title: p.title,
          device: p.device, surface: p.surface,
          posX: p.posX, posY: p.posY, width: p.width, height: p.height,
          // 透传临时 pageId,applyActions 据此与 createPage action 精确对应
          clientPageId: p.clientPageId,
        })),
      );
      updateMessage(pendingId, { pending: false, engine: result.engine, model: result.model, steps: result.steps });
      revealText(pendingId, result.assistantText);
      focusAffectedPage(result.actions, appliedPages);
    } catch (e) {
      abortRef.current = null;
      const aborted = (e as Error).name === "AbortError";
      updateMessage(pendingId, {
        content: aborted
          ? "已停止生成。"
          : `生成失败:${(e as Error).message.slice(0, 160)}。请稍后重试,或检查「设置」中的模型配置。`,
        pending: false,
        failedPrompt: aborted ? undefined : prompt,
        steps: aborted
          ? stepsBuf
          : [...stepsBuf, { key: "generate", label: "生成 A2UI", status: "error", detail: (e as Error).message.slice(0, 80) }],
      });
    } finally {
      setDraft(null);
      setGenerating(false);
    }
  };

  /** Plan 审批:执行 */
  const approvePlan = async (m: ChatMessage) => {
    if (!projectId || !m.plan || !m.planActions?.length) return;
    updateMessage(m.id, { plan: { ...m.plan, status: "approved" }, pending: true });
    setGenerating(true);
    try {
      const res = await applyPlanMut.mutateAsync({
        projectId,
        prompt: m.planPrompt ?? "执行计划",
        chips: m.chips ?? [],
        actions: m.planActions,
        engine: "kimi",
        assistantText: m.content,
        conversationId: useWorkspace.getState().conversationId,
        steps: (m.steps ?? []).map((s) => ({ ...s, status: s.status === "running" ? "done" as const : s.status })),
      });
      if (res.conversationId != null) useWorkspace.getState().setConversationId(res.conversationId);
      applyActions(
        m.planActions,
        (res.appliedPages ?? []).map((p) => ({
          id: p.id, projectId: p.projectId, title: p.title,
          device: p.device as never, surface: p.surface,
          posX: p.posX, posY: p.posY, width: p.width, height: p.height,
        })),
      );
      updateMessage(m.id, { pending: false, steps: res.steps as ChatStep[] });
      focusAffectedPage(m.planActions, res.appliedPages ?? []);
    } catch (e) {
      updateMessage(m.id, {
        pending: false,
        content: `${m.content}\n\n计划执行失败:${(e as Error).message.slice(0, 120)}`,
      });
    } finally {
      setGenerating(false);
    }
  };

  const rejectPlan = (m: ChatMessage) => {
    if (!m.plan) return;
    updateMessage(m.id, {
      plan: { ...m.plan, status: "rejected" },
      content: `${m.content}\n\n已放弃该计划,画布未做任何修改。`,
    });
  };

  const engine = settingsQ.data?.hasApiKey ? "kimi" : null;
  /** 图片对话能力:设置加载完成前按不支持处理(安全降级:隐藏入口、拦截粘贴) */
  const supportsImages = settingsQ.data?.supportsImages === true;
  /** 引擎显示名:OpenAI 兼容通道按模型/端点推断真实服务商(Kimi / DeepSeek / GPT…) */
  const engineName = engine ? engineDisplayName(engine, settingsQ.data?.model, settingsQ.data?.baseUrl) : null;

  return (
    <aside className="relative flex shrink-0 flex-col border-l border-neutral-200 bg-white" style={{ width: panelWidth }}>
      {/* 左缘拖拽手柄:调整面板宽度 */}
      <div
        className="absolute left-0 top-0 z-20 h-full w-1 cursor-col-resize transition hover:bg-indigo-300/60"
        onMouseDown={() => setResizing(true)}
      />
      {/* 头部 */}
      <div className="flex h-12 shrink-0 items-center gap-2 overflow-hidden border-b border-neutral-100 px-3.5">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-indigo-600 text-white">
          <Bot size={13} />
        </span>
        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] ${
          engine ? "bg-emerald-50 text-emerald-600" : "bg-amber-50 text-amber-600"
        }`}>
          {engineName ?? "未配置 Key"}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <button title="会话管理" onClick={() => setShowConvList((v) => !v)}
            className={`rounded-lg p-1.5 transition ${showConvList ? "bg-indigo-50 text-indigo-600" : "text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"}`}>
            <MessageSquare size={14} />
          </button>
          <button title="清空会话历史" onClick={clearHistory}
            disabled={!messages.length || clearChatMut.isPending}
            className="rounded-lg p-1.5 text-neutral-400 transition hover:bg-red-50 hover:text-red-500 disabled:opacity-30">
            <Trash2 size={14} />
          </button>
          <button title="模型设置" onClick={onOpenSettings}
            className="rounded-lg p-1.5 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-600">
            <Settings2 size={14} />
          </button>
        </div>
      </div>

      {/* 会话管理面板:列表 / 新建 / 切换 / 删除 */}
      {showConvList && (
        <ConversationList
          projectId={projectId}
          conversationId={conversationId}
          onSwitch={(id) => { switchConversation(id); setShowConvList(false); }}
          onNew={newConversation}
          onRemovedCurrent={() => {
            const st = useWorkspace.getState();
            st.setMessages([]);
            st.setConversationId(null);
            setShowConvList(false);
          }}
        />
      )}

      {/* 消息流 */}
      <div className="relative min-h-0 flex-1">
        <div ref={listRef} onScroll={onListScroll} className="chat-scroll h-full overflow-y-auto p-3.5">
          {!messages.length && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-400">
                <Sparkles size={22} />
              </span>
              <div>
                <p className="text-sm font-medium text-neutral-600">用对话设计页面</p>
                <p className="mt-1 max-w-[240px] text-xs leading-relaxed text-neutral-400">
                  描述需求即可生成页面;点页面标题栏「选取组件」可选中元素精修。
                  变更会直接执行,画布实时可见;高风险变更会先给出计划待你确认;可随时点消息下方的「撤销」回退。
                </p>
              </div>
              <div className="mt-1 flex flex-col gap-1.5">
                {QUICK_PROMPTS.slice(0, 3).map((q) => (
                  <button key={q}
                    className="rounded-full border border-neutral-200 px-3 py-1.5 text-xs text-neutral-500 transition hover:border-indigo-300 hover:text-indigo-600"
                    onClick={() => send(q)}>
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="flex flex-col gap-4">
            {messages.map((m) => (
              <MessageItem key={m.id} m={m} onApprove={() => approvePlan(m)} onReject={() => rejectPlan(m)} onRetry={(p) => void send(p)} />
            ))}
          </div>
        </div>
        {/* 回到底部 */}
        {showJump && (
          <button
            onClick={jumpToBottom}
            className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-neutral-200 bg-white px-3 py-1.5 text-[11px] text-neutral-500 shadow-md transition hover:text-indigo-600">
            <ArrowDown size={11} /> 回到底部
          </button>
        )}
      </div>

      {/* 输入区 */}
      <div className="shrink-0 border-t border-neutral-100 p-3">
        {allChips.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            {allChips.map((c, i) => (
              <span key={i} className="flex items-center gap-1 rounded-full bg-indigo-50 px-2.5 py-1 text-xs text-indigo-700">
                {c.kind === "page" ? <Layers size={11} /> : <MousePointer2 size={11} />}
                <span className="max-w-[180px] truncate">{c.kind === "page" ? c.title : c.label}</span>
                <button className="rounded-full hover:bg-indigo-100" onClick={() => removeChip(c)}>
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        {images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {images.map((img, i) => (
              <span key={i} className="relative h-14 w-14 overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50">
                <img src={img.dataUrl} alt={img.name} className="h-full w-full object-cover" />
                <button
                  title="移除图片"
                  onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                  className="absolute right-0.5 top-0.5 rounded-full bg-black/60 p-0.5 text-white transition hover:bg-black/80">
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2 rounded-2xl border border-neutral-200 bg-neutral-50/60 p-2 transition focus-within:border-indigo-300 focus-within:bg-white">
          {/* 图片对话入口:仅模型支持时显示;不支持则隐藏并在粘贴时引导 */}
          {supportsImages && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files?.length) void addImages(e.target.files);
                  e.target.value = "";
                }}
              />
              <button
                title={`添加参考图片(最多 ${MAX_IMAGES} 张,可直接粘贴)`}
                disabled={generating}
                onClick={() => fileInputRef.current?.click()}
                className="rounded-xl p-2.5 text-neutral-400 transition hover:bg-neutral-100 hover:text-indigo-600 disabled:opacity-40">
                <ImagePlus size={15} />
              </button>
            </>
          )}
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
            }}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData?.files ?? []);
              if (!files.length) return;
              e.preventDefault();
              if (!supportsImages) {
                toast.error("当前模型不支持图片对话,已忽略图片。可在「设置」中开启 Vision,或换用支持图片的模型。");
                return;
              }
              void addImages(files);
            }}
            placeholder={
              selectedElements.length
                ? `已选 ${selectedElements.length} 个组件,如「都改成圆角」「删除这些组件」…`
                : allChips.length
                  ? "针对选中页面描述修改…"
                  : "描述你想要的页面…"
            }
            rows={2}
            className="max-h-32 flex-1 resize-none bg-transparent px-1.5 py-1 text-sm outline-none placeholder:text-neutral-400"
          />
          {generating ? (
            <button
              title="停止生成"
              onClick={stop}
              className="rounded-xl bg-neutral-800 p-2.5 text-white shadow transition hover:bg-neutral-700">
              <Square size={14} />
            </button>
          ) : (
            <button
              disabled={!input.trim()}
              onClick={() => send()}
              className="rounded-xl bg-indigo-600 p-2.5 text-white shadow transition hover:bg-indigo-500 disabled:opacity-40">
              <ArrowUp size={15} />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
