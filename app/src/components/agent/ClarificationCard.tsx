/**
 * 结构化澄清卡片(文档 §10 / §25)
 * single_select → RadioGroup 风格卡片;multi_select → Checkbox+Badge;
 * mixed → 选项 + 自定义输入;scale → 滑杆;custom_text → 文本域;boolean → 开关。
 * 支持跳过(采用推荐默认)与倒计时提示;所有选项可键盘访问。
 */
import { useEffect, useState } from "react";
import { Timer } from "lucide-react";
import type { ClarificationAnswer, ClarificationQuestion, ClarificationRequest } from "@contracts/clarification";

export function ClarificationCard({
  request,
  onSubmit,
}: {
  request: ClarificationRequest;
  onSubmit: (answers: ClarificationAnswer[]) => Promise<void>;
}) {
  const [selections, setSelections] = useState<Record<string, string[]>>(() => defaultsOf(request));
  // §25.3 ranked_choice:每个问题的当前排序(默认按选项声明顺序)
  const [ranks, setRanks] = useState<Record<string, string[]>>(() => defaultsRank(request));
  const [customs, setCustoms] = useState<Record<string, string>>({});
  const [scales, setScales] = useState<Record<string, number>>({});
  const [bools, setBools] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  // §15.3:优先用服务端 expiresAt(断线重连后倒计时不重置),否则按本地起点推算
  const remaining = request.expiresAt
    ? Math.max(0, Math.round((Date.parse(request.expiresAt) - now) / 1000))
    : Math.max(0, Math.round(request.timeoutSeconds - (now - startedAt) / 1000));

  const buildAnswers = (): ClarificationAnswer[] =>
    request.questions.map((q) => {
      const custom = customs[q.questionId]?.trim();
      if (q.responseType === "scale") {
        return { questionId: q.questionId, selectedOptionIds: [], rankedOptionIds: [], scaleValue: scales[q.questionId] ?? q.scaleMin ?? 0, skipped: false };
      }
      if (q.responseType === "boolean") {
        return { questionId: q.questionId, selectedOptionIds: [], rankedOptionIds: [], boolValue: bools[q.questionId] ?? false, skipped: false };
      }
      if (q.responseType === "ranked_choice") {
        return { questionId: q.questionId, selectedOptionIds: [], rankedOptionIds: ranks[q.questionId] ?? q.options.map((o) => o.optionId), skipped: false };
      }
      if (custom) {
        return { questionId: q.questionId, selectedOptionIds: [], rankedOptionIds: [], customText: custom, skipped: false };
      }
      return { questionId: q.questionId, selectedOptionIds: selections[q.questionId] ?? [], rankedOptionIds: [], skipped: false };
    });

  const submit = async (skipAll: boolean) => {
    setBusy(true);
    try {
      const answers: ClarificationAnswer[] = skipAll
        ? request.questions.map((q) => ({ questionId: q.questionId, selectedOptionIds: [], rankedOptionIds: [], skipped: true }))
        : buildAnswers();
      await onSubmit(answers);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-amber-300 bg-amber-50/50 p-3 text-xs dark:border-amber-800 dark:bg-amber-950/20">
      <div className="flex items-center justify-between">
        <div className="font-medium">为生成更准确的结果,请确认 {request.questions.length} 个问题</div>
        <div className="inline-flex items-center gap-1 text-muted-foreground">
          <Timer className="size-3" />
          {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}
        </div>
      </div>
      {request.reason && <div className="text-muted-foreground">{request.reason}</div>}

      {request.questions.map((q, idx) => (
        <QuestionCard
          key={q.questionId}
          index={idx}
          total={request.questions.length}
          question={q}
          selected={selections[q.questionId] ?? []}
          custom={customs[q.questionId] ?? ""}
          scale={scales[q.questionId]}
          bool={bools[q.questionId]}
          ranked={ranks[q.questionId] ?? q.options.map((o) => o.optionId)}
          onRank={(from, to) =>
            setRanks((r) => {
              const cur = [...(r[q.questionId] ?? q.options.map((o) => o.optionId))];
              const [moved] = cur.splice(from, 1);
              cur.splice(to, 0, moved!);
              return { ...r, [q.questionId]: cur };
            })
          }
          onSelect={(ids) => setSelections((s) => ({ ...s, [q.questionId]: ids }))}
          onCustom={(v) => setCustoms((s) => ({ ...s, [q.questionId]: v }))}
          onScale={(v) => setScales((s) => ({ ...s, [q.questionId]: v }))}
          onBool={(v) => setBools((s) => ({ ...s, [q.questionId]: v }))}
        />
      ))}

      <div className="flex items-center justify-between pt-1">
        {request.canSkipAll ? (
          <button disabled={busy} onClick={() => void submit(true)} className="rounded-md border px-3 py-1.5 hover:bg-muted">
            跳过并使用推荐
          </button>
        ) : <span />}
        <button disabled={busy} onClick={() => void submit(false)} className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground">
          确认并继续
        </button>
      </div>
    </div>
  );
}

function QuestionCard({
  index, total, question: q, selected, custom, scale, bool, ranked, onRank, onSelect, onCustom, onScale, onBool,
}: {
  index: number;
  total: number;
  question: ClarificationQuestion;
  selected: string[];
  custom: string;
  scale?: number;
  bool?: boolean;
  /** §25.3 ranked_choice:当前排序(optionId 顺序) */
  ranked: string[];
  onRank: (from: number, to: number) => void;
  onSelect: (ids: string[]) => void;
  onCustom: (v: string) => void;
  onScale: (v: number) => void;
  onBool: (v: boolean) => void;
}) {
  const toggle = (id: string) => {
    if (q.responseType === "single_select") {
      onSelect([id]);
      return;
    }
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    if (q.maxSelections && next.length > q.maxSelections) return;
    onSelect(next);
  };

  return (
    <div className="rounded-md border bg-background p-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="font-medium">{index + 1}. {q.title}</span>
        <span className="rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
          {q.required ? `必答 ${index + 1}/${total}` : "可选"}
        </span>
      </div>
      {q.description && <div className="mb-2 text-muted-foreground">{q.description}</div>}

      {(q.responseType === "single_select" || q.responseType === "multi_select" || q.responseType === "mixed") &&
        q.options.map((o) => {
          const active = selected.includes(o.optionId);
          return (
            <button
              key={o.optionId}
              onClick={() => toggle(o.optionId)}
              className={`mb-1.5 flex w-full items-start gap-2 rounded-md border p-2 text-left transition-colors ${
                active ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:bg-muted/50"
              }`}
            >
              <span className={`mt-0.5 size-3.5 shrink-0 rounded-full border-2 ${active ? "border-primary bg-primary" : "border-muted-foreground/40"}`} />
              <span className="min-w-0">
                <span className="font-medium">{o.label}</span>
                {o.description && <span className="block text-muted-foreground">{o.description}</span>}
                {o.consequences.length > 0 && (
                  <span className="block text-[10px] text-muted-foreground">后果:{o.consequences.join(";")}</span>
                )}
              </span>
            </button>
          );
        })}

      {q.responseType === "scale" && (
        <input
          type="range"
          className="w-full"
          min={q.scaleMin ?? 0}
          max={q.scaleMax ?? 100}
          step={q.scaleStep ?? 1}
          value={scale ?? q.scaleMin ?? 0}
          onChange={(e) => onScale(Number(e.target.value))}
          aria-label={q.title}
        />
      )}

      {q.responseType === "boolean" && (
        <button
          onClick={() => onBool(!bool)}
          className={`rounded-full px-3 py-1 ${bool ? "bg-primary text-primary-foreground" : "bg-muted"}`}
        >
          {bool ? "是" : "否"}
        </button>
      )}

      {/* §25.3 ranked_choice:上下箭头排序(零依赖,不引入拖拽库) */}
      {q.responseType === "ranked_choice" && (
        <div className="space-y-1">
          {ranked.map((oid, i) => {
            const o = q.options.find((x) => x.optionId === oid);
            if (!o) return null;
            return (
              <div key={oid} className="flex items-center gap-2 rounded-md border p-1.5">
                <span className="w-5 shrink-0 text-center text-[10px] tabular-nums text-muted-foreground">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{o.label}</span>
                  {o.description && <span className="block truncate text-[10px] text-muted-foreground">{o.description}</span>}
                </span>
                <button
                  aria-label={`上移 ${o.label}`}
                  disabled={i === 0}
                  onClick={() => onRank(i, i - 1)}
                  className="rounded px-1.5 py-0.5 text-muted-foreground transition hover:bg-muted disabled:opacity-25"
                >
                  ↑
                </button>
                <button
                  aria-label={`下移 ${o.label}`}
                  disabled={i === ranked.length - 1}
                  onClick={() => onRank(i, i + 1)}
                  className="rounded px-1.5 py-0.5 text-muted-foreground transition hover:bg-muted disabled:opacity-25"
                >
                  ↓
                </button>
              </div>
            );
          })}
          <div className="text-[10px] text-muted-foreground">用 ↑↓ 调整优先级,排在前面的优先采纳。</div>
        </div>
      )}

      {(q.allowCustom || q.responseType === "custom_text" || q.responseType === "mixed") && (
        <input
          value={custom}
          onChange={(e) => onCustom(e.target.value)}
          placeholder={q.customPlaceholder || "自定义补充…"}
          className="mt-1 w-full rounded-md border bg-background p-1.5 outline-none focus:ring-1 focus:ring-ring"
          aria-label={`${q.title}(自定义)`}
        />
      )}
    </div>
  );
}

function defaultsOf(request: ClarificationRequest): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const q of request.questions) out[q.questionId] = [...q.defaultOptionIds];
  return out;
}

/** §25.3 ranked_choice 初始排序:选项声明顺序 */
function defaultsRank(request: ClarificationRequest): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const q of request.questions) {
    if (q.responseType === "ranked_choice") out[q.questionId] = q.options.map((o) => o.optionId);
  }
  return out;
}
