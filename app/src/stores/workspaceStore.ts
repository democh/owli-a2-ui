import { create } from "zustand";
import type {
  ChatAction,
  ChatStep,
  ContextChip,
  DeviceId,
  EditPlan,
  PresetId,
  SurfaceDoc,
} from "@contracts/a2ui";
import { applyOps, DEVICES } from "@contracts/a2ui";

export interface PageState {
  id: number;
  projectId: number;
  title: string;
  device: DeviceId;
  surface: SurfaceDoc;
  posX: number;
  posY: number;
  width: number;
  height: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  chips?: ContextChip[];
  /** 用户消息附带的参考图片(dataUrl 缩略图,仅回显) */
  images?: string[];
  engine?: string;
  /** 实际调用的模型名(引擎标签展示;历史消息可能缺省) */
  model?: string;
  pending?: boolean;
  /** 结论打字机输出中(显示流式光标) */
  streaming?: boolean;  /** Harness Agent 执行步骤 */
  steps?: ChatStep[];
  /** Plan 模式:待审批计划(含审批状态与原始 actions) */
  plan?: EditPlan & { status: "proposed" | "approved" | "rejected" };
  planActions?: ChatAction[];
  planPrompt?: string;
  /** 生成失败时记录原始 prompt,供结论行「重试」按钮一键重发(仅内存,不落库) */
  failedPrompt?: string;
}

/** undo/redo 快照:页面数组 + 风格预设 */
export interface Snapshot {
  pages: PageState[];
  preset: PresetId;
}

/** 流式生成草稿:LLM 逐 token 输出期间的画布渐进预览(不落库) */
export interface StreamDraft {
  /** create 模式:幻影画框列表(多页流式生成时逐页出现;负 id,完成后被真实页面替换) */
  ghosts: PageState[];
  /** edit 模式:就地预览的目标页面 id */
  targetPageId: number | null;
  /** 增量解析出的部分文档(edit 模式用) */
  surface: SurfaceDoc | null;
}

interface WorkspaceState {
  projectId: number | null;
  projectName: string;
  preset: PresetId;
  pages: PageState[];
  selectedPageIds: number[];
  /** 选中的页面内组件(支持多选,与 AI 对话时作为上下文 chips) */
  selectedElements: { pageId: number; aid: string; componentType: string }[];
  inspectMode: boolean;
  zoom: number;
  generating: boolean;
  chatExpanded: boolean;
  /** 左栏显隐(持久化到 localStorage) */
  leftPanelVisible: boolean;
  messages: ChatMessage[];
  conversationId: number | null;
  /** 流式生成草稿(渐进渲染预览,不落库) */
  draft: StreamDraft | null;
  /** 图层树/检查器点击组件后,请求对应 iframe 闪烁高亮一次(seq 保证重复点击同一组件也触发) */
  highlightReq: { pageId: number; aid: string | null; seq: number } | null;

  // undo/redo(页面 surface+几何+风格预设 快照)
  past: Snapshot[];
  future: Snapshot[];

  initProject: (p: {
    id: number;
    name: string;
    preset: PresetId;
    pages: PageState[];
  }) => void;
  setZoom: (z: number) => void;
  setSelectedPages: (ids: number[]) => void;
  setSelectedElements: (els: { pageId: number; aid: string; componentType: string }[]) => void;
  setInspectMode: (on: boolean) => void;
  setChatExpanded: (v: boolean) => void;
  setMessages: (msgs: ChatMessage[]) => void;
  setConversationId: (id: number | null) => void;
  pushMessage: (m: ChatMessage) => void;
  updateMessage: (id: string, patch: Partial<ChatMessage>) => void;
  setGenerating: (v: boolean) => void;
  setPreset: (p: PresetId) => void;
  setLeftPanelVisible: (v: boolean) => void;
  updatePageLocal: (id: number, patch: Partial<PageState>) => void;
  addPage: (p: PageState) => void;
  removePage: (id: number) => void;
  applyActions: (actions: ChatAction[], appliedPages?: (PageState & { clientPageId?: string })[]) => void;
  setDraft: (d: StreamDraft | null) => void;
  requestHighlight: (pageId: number, aid: string | null) => void;
  snapshotForUndo: () => void;
  undo: () => Snapshot | null;
  redo: () => Snapshot | null;
  chips: () => ContextChip[];
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  projectId: null,
  projectName: "",
  preset: "shadcn",
  pages: [],
  selectedPageIds: [],
  selectedElements: [],
  inspectMode: false,
  zoom: 0.45,
  generating: false,
  chatExpanded: false,
  leftPanelVisible: typeof localStorage !== "undefined" ? localStorage.getItem("a2.leftPanel") !== "0" : true,
  messages: [],
  conversationId: null,
  draft: null,
  highlightReq: null,
  past: [],
  future: [],

  initProject: ({ id, name, preset, pages }) =>
    set({
      projectId: id,
      projectName: name,
      preset,
      pages,
      selectedPageIds: [],
      selectedElements: [],
      past: [],
      future: [],
      messages: [],
      conversationId: null,
    }),

  setZoom: (zoom) => set({ zoom }),
  setSelectedPages: (ids) => set({ selectedPageIds: ids, selectedElements: [] }),
  setSelectedElements: (els) => set({ selectedElements: els }),
  setInspectMode: (on) => set({ inspectMode: on }),
  setChatExpanded: (chatExpanded) => set({ chatExpanded }),
  setMessages: (messages) => set({ messages }),
  setConversationId: (conversationId) => set({ conversationId }),
  pushMessage: (m) => set((s) => ({ messages: [...s.messages, m] })),
  updateMessage: (id, patch) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    })),
  setGenerating: (generating) => set({ generating }),
  setPreset: (preset) => set({ preset }),
    setLeftPanelVisible: (leftPanelVisible) => {
    try { localStorage.setItem("a2.leftPanel", leftPanelVisible ? "1" : "0"); } catch { /* ignore */ }
    set({ leftPanelVisible });
  },

  updatePageLocal: (id, patch) =>
    set((s) => ({
      pages: s.pages.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    })),

  addPage: (p) => set((s) => ({ pages: [...s.pages, p] })),

  removePage: (id) =>
    set((s) => ({
      pages: s.pages.filter((p) => p.id !== id),
      selectedPageIds: s.selectedPageIds.filter((x) => x !== id),
    })),

  applyActions: (actions, appliedPages) => {
    const s = get();
    let pages = [...s.pages];
    let preset = s.preset;
    for (const action of actions) {
      if (action.type === "createPage") {
        // 优先用临时 pageId 精确对应(同名页面不串);clientPageId 缺失时回退标题匹配(兼容旧数据)
        const applied =
          appliedPages?.find((p) => p.clientPageId && p.clientPageId === action.pageId) ??
          appliedPages?.find((p) => p.title === action.title);
        if (applied) {
          if (!pages.some((p) => p.id === applied.id)) pages.push(applied);
        } else {
          const maxX = pages.reduce((m, p) => Math.max(m, p.posX + p.width), 0);
          const newPage: PageState = {
            id: -Date.now(),
            projectId: s.projectId ?? 0,
            title: action.title,
            device: action.device,
            surface: action.surface,
            posX: maxX ? maxX + 160 : 0,
            posY: 0,
            width: DEVICES[action.device].width,
            height: DEVICES[action.device].height,
          };
          pages.push(newPage);
        }
      } else if (action.type === "updateSurface") {
        const pid = Number(action.pageId);
        pages = pages.map((p) =>
          p.id === pid
            ? { ...p, surface: action.surface, title: action.surface.page.title || p.title, device: action.surface.page.device }
            : p,
        );
      } else if (action.type === "ops") {
        const pid = Number(action.pageId);
        pages = pages.map((p) => {
          if (p.id !== pid) return p;
          const surface = applyOps(p.surface, action.ops);
          return { ...p, surface, title: surface.page.title || p.title };
        });
      } else if (action.type === "setPreset") {
        preset = action.preset;
      }
    }
    set({ pages, preset });
  },

  setDraft: (draft) => set({ draft }),

  requestHighlight: (pageId, aid) =>
    set((s) => ({ highlightReq: { pageId, aid, seq: (s.highlightReq?.seq ?? 0) + 1 } })),

  snapshotForUndo: () =>
    set((s) => ({
      past: [...s.past.slice(-30), { pages: s.pages, preset: s.preset }],
      future: [],
    })),

  undo: () => {
    const s = get();
    if (!s.past.length) return null;
    const prev = s.past[s.past.length - 1];
    set({
      past: s.past.slice(0, -1),
      future: [{ pages: s.pages, preset: s.preset }, ...s.future].slice(0, 30),
      pages: prev.pages,
      preset: prev.preset,
    });
    return prev;
  },

  redo: () => {
    const s = get();
    if (!s.future.length) return null;
    const next = s.future[0];
    set({
      future: s.future.slice(1),
      past: [...s.past, { pages: s.pages, preset: s.preset }],
      pages: next.pages,
      preset: next.preset,
    });
    return next;
  },

  chips: () => {
    const s = get();
    const chips: ContextChip[] = [];
    // 元素多选:每个选中组件一个 chip
    if (s.selectedElements.length) {
      for (const el of s.selectedElements) {
        const page = s.pages.find((p) => p.id === el.pageId);
        if (page)
          chips.push({
            kind: "element",
            pageId: String(el.pageId),
            aid: el.aid,
            label: `${page.title} · ${el.componentType}#${el.aid}`,
          });
      }
      return chips;
    }
    for (const pid of s.selectedPageIds.slice(0, 3)) {
      const page = s.pages.find((p) => p.id === pid);
      if (page) chips.push({ kind: "page", pageId: String(pid), title: page.title });
    }
    return chips;
  },
}));
