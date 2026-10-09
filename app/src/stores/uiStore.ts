import { create } from "zustand";

/**
 * uiStore —— 工作台 UI 密度(全局紧凑模式)
 *
 * compact=true 时工作台整体收紧:顶栏/状态栏/Agent 面板/卡片间距/字号密度
 * 全部走 .a2-compact 作用域样式(index.css);选择持久化到 localStorage。
 * 文档对应关系:StyleDirection.layoutPreferences.density 的编辑器侧实现。
 */

const STORAGE_KEY = "a2.ui.compact";

function readInitial(): boolean {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === null ? true : v === "1"; // 默认紧凑
  } catch {
    return true;
  }
}

interface UiState {
  compact: boolean;
  toggleCompact: () => void;
  setCompact: (v: boolean) => void;
}

export const useUiStore = create<UiState>((set) => ({
  compact: readInitial(),
  toggleCompact: () =>
    set((s) => {
      const next = !s.compact;
      try {
        localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* 隐私模式忽略 */
      }
      return { compact: next };
    }),
  setCompact: (v) => {
    try {
      localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
    } catch {
      /* ignore */
    }
    set({ compact: v });
  },
}));
