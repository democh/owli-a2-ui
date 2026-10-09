/**
 * 宿主工作台 ↔ iframe 渲染器 的 postMessage 协议
 */
import type { PresetId, SurfaceDoc } from "@contracts/a2ui";

export const IPC_SOURCE = "a2ui-renderer";

// parent → iframe
export interface NodeDiff {
  added: string[];
  updated: string[];
  removed: string[];
}

export type HostMessage =
  | { source: typeof IPC_SOURCE; type: "setSurface"; doc: SurfaceDoc; preset: PresetId }
  | { source: typeof IPC_SOURCE; type: "setInspect"; on: boolean }
  | { source: typeof IPC_SOURCE; type: "highlight"; aid: string | null }
  /** M7 逐节点持久 Diff 着色:最近一次提交的增/改/删组件(按 aid) */
  | { source: typeof IPC_SOURCE; type: "setDiff"; diff: NodeDiff | null }
  /** M7 评论锚点气泡:未解决评论按 nodeId 定位渲染 */
  | { source: typeof IPC_SOURCE; type: "setComments"; comments: { id: number; nodeId: string; body: string; authorName: string | null; resolved: boolean }[] };

// iframe → parent
export type RendererMessage =
  | { source: typeof IPC_SOURCE; type: "ready" }
  | {
      source: typeof IPC_SOURCE;
      type: "select";
      /** 当前选中的全部组件(多选);空数组表示清空选择 */
      aids: string[];
      items: { aid: string; componentType: string }[];
    }
  | { source: typeof IPC_SOURCE; type: "commentClick"; nodeId: string }
  | {
      /** inspect 模式下双击文本类组件:请求宿主在对应位置弹出内联文本编辑器 */
      source: typeof IPC_SOURCE;
      type: "textEdit";
      aid: string;
      /** 主文本 prop 名(如 Title/Text 的 text、Button 的 label) */
      prop: string;
      value: string;
      /** 组件在 iframe 视口内的位置(宿主据此放置编辑器浮层) */
      rect: { x: number; y: number; w: number; h: number };
    }
  | { source: typeof IPC_SOURCE; type: "navigate"; page: string };

export function postToIframe(win: Window | null, msg: HostMessage) {
  win?.postMessage(msg, window.location.origin);
}

export function postToHost(msg: RendererMessage) {
  window.parent?.postMessage(msg, window.location.origin);
}
