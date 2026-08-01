/**
 * 消息项:用户气泡 / Agent Turn(执行轨迹)
 * 包含工具调用卡(ToolSteps)与计划审批卡(PlanCard)
 */
import { memo, useEffect, useState } from "react";
import {
  AlertCircle, Check, ChevronDown, ChevronRight, ClipboardList, Loader2, Play, Redo2, RotateCcw, Sparkles, Undo2,
} from "lucide-react";
import type { ChatMessage } from "@/stores/workspaceStore";
import { useUndoRedo } from "@/hooks/useUndoRedo";
import type { ChatStep } from "@contracts/a2ui";
import { engineDisplayName } from "@contracts/a2ui";
import { NEXT_PHASE, STEP_ICON } from "./constants";
import { Markdown } from "./Markdown";

export const MessageItem = memo(function MessageItem({ m, onApprove, onReject, onRetry }: { m: ChatMessage; onApprove: () => void; onReject: () => void; onRetry?: (prompt: string) => void }) {
  const { doUndo, doRedo, canUndo, canRedo } = useUndoRedo();

  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] rounded-2xl rounded-tr-sm bg-neutral-800 px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap text-white">
          {m.chips && m.chips.length > 0 && (
            <span className="mb-1.5 flex flex-wrap gap-1">
              {m.chips.map((c, i) => (
                <span key={i} className="rounded bg-white/20 px-1.5 py-0.5 text-[10px]">
                  {c.kind === "page" ? c.title : c.label}
                </span>
              ))}
            </span>
          )}
          {m.images && m.images.length > 0 && (
            <span className="mb-1.5 flex flex-wrap gap-1.5">
              {m.images.map((src, i) => (
                <img key={i} src={src} alt={`参考图 ${i + 1}`} className="h-16 w-16 rounded-lg border border-white/20 object-cover" />
              ))}
            </span>
          )}
          {m.content}
        </div>
      </div>
    );
  }

  // Agent Turn:左时间线容器,思考/工具卡/计划卡/结论都是轨迹上的 Item
  // 渲染层按 id 去重(保留最后出现):防御任何来源的 running 进度行重复
  const dedup = (arr: ChatStep[]): ChatStep[] => {
    const idxById = new Map<string, number>();
    const out: ChatStep[] = [];
    for (const s of arr) {
      const i = s.id ? idxById.get(s.id) : undefined;
      if (i != null) { out[i] = s; continue; }
      if (s.id) idxById.set(s.id, out.length);
      out.push(s);
    }
    return out;
  };
  const allSteps = dedup(m.steps ?? []);
  const thoughtSteps = allSteps.filter((s) => s.key === "understand" || s.key === "context" || s.key === "plan");
  const toolSteps = allSteps.filter((s) => s.key !== "understand" && s.key !== "context" && s.key !== "plan");
  const done = !m.pending;

  // 流式进行中:根据最后收到的步骤推测当前阶段,合成 running 行;
  // 已有真实 running 步骤(timeIt 推送)时不再重复显示占位
  const lastStep = m.steps?.[m.steps.length - 1];
  const hasRunning = m.steps?.some((s) => s.status === "running");
  const runningLabel = m.pending && !hasRunning && lastStep?.status !== "error" ? NEXT_PHASE[lastStep?.key ?? ""] ?? "生成 A2UI" : null;

  return (
    <div className="relative border-l-2 border-indigo-100 pl-3">
      {/* 思考行(意图理解,浅灰小字) */}
      {thoughtSteps.length > 0 && (
        <div className="mb-1.5 flex flex-col gap-0.5">
          {thoughtSteps.map((s, i) => (
            <div key={i} className="flex items-center gap-1.5 text-[11px] text-neutral-400">
              <Sparkles size={10} className="shrink-0 text-indigo-300" />
              <span className="truncate">{s.label}{s.detail ? ` · ${s.detail}` : ""}</span>
            </div>
          ))}
        </div>
      )}

      {/* 工具调用卡组 */}
      {toolSteps.length > 0 && <ToolSteps steps={toolSteps} running={m.pending} />}

      {/* 当前阶段(running 合成行;已有真实 running 步骤时隐藏) */}
      {m.pending && !hasRunning && (
        <div className="mt-1 flex items-center gap-2 rounded-xl bg-neutral-50 px-3.5 py-2.5 text-sm text-neutral-500">
          <Loader2 size={14} className="animate-spin text-indigo-500" />
          {runningLabel ? `${runningLabel}…` : "正在理解需求…"}
        </div>
      )}

      {/* 计划审批卡 */}
      {m.plan && <PlanCard m={m} onApprove={onApprove} onReject={onReject} />}

      {/* 结论(Markdown 渲染 + 流式光标)+ 内联操作 */}
      {(!!m.content || m.streaming) && (
        <div className="mt-1.5 text-sm leading-relaxed text-neutral-800">
          <Markdown text={m.content} streaming={m.streaming} />
          {!m.streaming && (
            <div className="mt-2 flex items-center gap-1.5">
              {m.engine && (
                <span className="text-[10px] text-neutral-300">
                  {engineDisplayName(m.engine, m.model)}
                </span>
              )}
              {done && m.failedPrompt && onRetry && (
                <button
                  title="重新发送这次请求"
                  onClick={() => onRetry(m.failedPrompt!)}
                  className="ml-auto flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-600 transition hover:border-amber-300 hover:text-amber-700">
                  <RotateCcw size={11} /> 重试
                </button>
              )}
              {done && !m.failedPrompt && (
                <span className="ml-auto flex items-center gap-1">
                  <button
                    title="撤销这次修改"
                    disabled={!canUndo}
                    onClick={doUndo}
                    className="flex items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-[11px] text-neutral-500 transition hover:border-indigo-300 hover:text-indigo-600 disabled:opacity-40">
                    <Undo2 size={11} /> 撤销
                  </button>
                  <button
                    title="重做"
                    disabled={!canRedo}
                    onClick={doRedo}
                    className="flex items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-[11px] text-neutral-500 transition hover:border-indigo-300 hover:text-indigo-600 disabled:opacity-40">
                    <Redo2 size={11} /> 重做
                  </button>
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// 工具调用卡:args/result 同卡,完成 3 秒后整组折叠
// ---------------------------------------------------------------------------
function ToolSteps({ steps, running }: { steps: ChatStep[]; running?: boolean }) {
  const [collapsed, setCollapsed] = useState(false);
  const allDone = !running && steps.every((s) => s.status !== "running");

  // 新一轮步骤到达时在渲染期重置展开(官方推荐的 adjust-state-during-render 模式)
  const [prevSteps, setPrevSteps] = useState(steps);
  if (steps !== prevSteps) {
    setPrevSteps(steps);
    if (collapsed) setCollapsed(false);
  }

  // 全部完成 3 秒后自动折叠为一行摘要
  useEffect(() => {
    if (!allDone) return;
    const t = setTimeout(() => setCollapsed(true), 3000);
    return () => clearTimeout(t);
  }, [allDone, steps]);

  const totalMs = steps.reduce((s, x) => s + (x.durationMs ?? 0), 0);
  const hasError = steps.some((s) => s.status === "error");

  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        className="flex w-fit items-center gap-1.5 rounded-full bg-neutral-50 px-2.5 py-1 text-[11px] text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-600">
        {hasError ? <AlertCircle size={11} className="text-amber-500" /> : <Check size={11} className="text-emerald-500" />}
        {hasError ? "部分步骤失败" : `已完成 ${steps.length} 步`}
        {totalMs > 0 && ` · ${(totalMs / 1000).toFixed(1)}s`}
        <ChevronRight size={11} />
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-1 rounded-xl bg-neutral-50/70 p-1.5">
      <div className="flex items-center justify-between px-1.5 pt-0.5">
        <span className="text-[10px] font-medium uppercase tracking-wide text-neutral-400">Agent 执行过程</span>
        {allDone && (
          <button onClick={() => setCollapsed(true)} className="text-neutral-300 hover:text-neutral-500">
            <ChevronDown size={11} />
          </button>
        )}
      </div>
      {steps.map((s, i) => {
        const Icon = STEP_ICON[s.key] ?? Play;
        return (
          <div key={i} className="flex items-start gap-2 rounded-lg bg-white px-2.5 py-1.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md ${
              s.status === "running" ? "bg-indigo-50 text-indigo-500"
              : s.status === "error" ? "bg-amber-50 text-amber-500"
              : "bg-emerald-50 text-emerald-500"
            }`}>
              {s.status === "running" ? <Loader2 size={11} className="animate-spin" /> : s.status === "error" ? <AlertCircle size={11} /> : <Icon size={11} />}
            </span>
            <div className="min-w-0 flex-1">
              <span className={`text-xs ${s.status === "running" ? "font-medium text-indigo-600" : "text-neutral-600"}`}>
                {s.label}
              </span>
              {!!s.detail && <span className="ml-1.5 text-[11px] text-neutral-400">{s.detail}</span>}
            </div>
            {s.durationMs != null && s.status === "done" && (
              <span className="shrink-0 text-[10px] tabular-nums text-neutral-300">
                {s.durationMs < 1000 ? `${s.durationMs}ms` : `${(s.durationMs / 1000).toFixed(1)}s`}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 计划审批卡(Plan 模式)
// ---------------------------------------------------------------------------
function PlanCard({ m, onApprove, onReject }: { m: ChatMessage; onApprove: () => void; onReject: () => void }) {
  const plan = m.plan!;
  const proposed = plan.status === "proposed";
  return (
    <div className={`mt-1.5 rounded-xl border p-3 ${
      proposed ? "border-amber-200 bg-amber-50/60"
      : plan.status === "approved" ? "border-emerald-200 bg-emerald-50/50"
      : "border-neutral-200 bg-neutral-50/60"
    }`}>
      <div className="flex items-center gap-1.5 text-xs font-semibold">
        <ClipboardList size={13} className={proposed ? "text-amber-500" : plan.status === "approved" ? "text-emerald-500" : "text-neutral-400"} />
        <span className={proposed ? "text-amber-700" : plan.status === "approved" ? "text-emerald-700" : "text-neutral-500"}>
          变更计划{plan.status === "approved" ? " · 已执行" : plan.status === "rejected" ? " · 已放弃" : " · 待审批"}
        </span>
        {plan.risk === "medium" && (
          <span className="ml-auto rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-medium text-red-500">含高风险操作</span>
        )}
      </div>
      <ul className="mt-2 flex flex-col gap-1">
        {plan.items.map((item, i) => (
          <li key={i} className="flex items-start gap-1.5 text-xs leading-relaxed text-neutral-600">
            <span className={`mt-1.5 h-1 w-1 shrink-0 rounded-full ${item.risk === "medium" ? "bg-red-400" : "bg-neutral-300"}`} />
            {item.description}
          </li>
        ))}
      </ul>
      {proposed && (
        <div className="mt-3 flex gap-2">
          <button
            onClick={onApprove}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-indigo-500">
            <Play size={12} /> 执行计划
          </button>
          <button
            onClick={onReject}
            className="rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs text-neutral-500 transition hover:bg-neutral-50">
            放弃
          </button>
        </div>
      )}
    </div>
  );
}
