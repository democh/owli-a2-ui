/**
 * 会话管理面板:列表 / 新建 / 切换 / 删除
 * 由 AgentPanel 按需挂载(showConvList 时渲染),挂载即加载列表
 */
import { Loader2, Plus, Trash2 } from "lucide-react";
import { trpc } from "@/providers/trpc";

interface ConversationListProps {
  projectId: number | null;
  conversationId: number | null;
  /** 切换到指定会话 */
  onSwitch: (id: number) => void;
  /** 新建空会话(清空面板,首次发送时后端自动建档) */
  onNew: () => void;
  /** 删除的恰好是当前会话时,由父组件重置面板 */
  onRemovedCurrent: () => void;
}

export function ConversationList({ projectId, conversationId, onSwitch, onNew, onRemovedCurrent }: ConversationListProps) {
  const convListQ = trpc.chat.conversations.useQuery(
    { projectId: projectId ?? 0 },
    { enabled: !!projectId },
  );
  const removeConvMut = trpc.chat.removeConversation.useMutation({
    onSuccess: (_r, vars) => {
      convListQ.refetch();
      if (vars.id === conversationId) onRemovedCurrent();
    },
  });

  return (
    <div className="absolute inset-x-0 top-12 z-30 border-b border-neutral-200 bg-white shadow-lg">
      <div className="flex items-center justify-between px-3.5 py-2.5">
        <span className="text-xs font-medium text-neutral-500">会话列表</span>
        <button
          onClick={onNew}
          className="flex items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-indigo-500">
          <Plus size={11} /> 新建会话
        </button>
      </div>
      <div className="chat-scroll max-h-64 overflow-y-auto px-1.5 pb-2">
        {convListQ.isLoading && (
          <div className="flex items-center justify-center gap-2 py-4 text-xs text-neutral-400">
            <Loader2 size={12} className="animate-spin" /> 加载中…
          </div>
        )}
        {!convListQ.isLoading && !convListQ.data?.length && (
          <p className="py-4 text-center text-xs text-neutral-400">暂无历史会话,点击「新建会话」开始</p>
        )}
        {convListQ.data?.map((c) => {
          const active = c.id === conversationId;
          return (
            <div key={c.id}
              className={`group flex items-center gap-2 rounded-lg px-2 py-2 transition ${
                active ? "bg-indigo-50" : "hover:bg-neutral-50"
              }`}>
              <button
                className="min-w-0 flex-1 text-left"
                onClick={() => onSwitch(c.id)}>
                <p className={`truncate text-xs ${active ? "font-medium text-indigo-700" : "text-neutral-600"}`}>
                  {c.title || "未命名会话"}
                </p>
                <p className="mt-0.5 text-[10px] text-neutral-400">
                  {c.messageCount} 条消息{c.createdAt ? ` · ${new Date(c.createdAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}` : ""}
                </p>
              </button>
              <button
                title="删除该会话"
                disabled={removeConvMut.isPending}
                onClick={() => {
                  if (!projectId) return;
                  if (!window.confirm(`删除会话「${c.title || "未命名会话"}」?该会话的消息记录将一并删除。`)) return;
                  removeConvMut.mutate({ id: c.id, projectId });
                }}
                className="shrink-0 rounded-md p-1 text-neutral-300 opacity-0 transition group-hover:opacity-100 hover:bg-red-50 hover:text-red-500">
                <Trash2 size={12} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
