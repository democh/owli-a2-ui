/**
 * MarkdownLite —— Agent 输出的安全 Markdown 渲染(文档 §14.6)
 *
 * 支持文档要求的子集:GFM 列表/任务列表/粗斜体/行内代码/表格/代码块(默认折叠,可复制/应用为 Proposal)
 * + 画布引用 chips(@page/@frame/@node/#skill)+ 提示块(:::callout)
 * + 扩展块(:::plan / :::artifact / :::diff)+ Mermaid 图表(动态 import,失败降级源码)。
 * 安全渲染:不渲染原始 HTML、不执行脚本、解析失败降级为纯文本。
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy, Locate, Wand2 } from "lucide-react";

interface Block {
  type: "p" | "ul" | "tasklist" | "code" | "callout" | "heading" | "table" | "plan" | "artifact" | "diff";
  level?: number;
  lang?: string;
  text: string;
  items?: string[];
  checked?: boolean[];
  calloutType?: string;
  /** :::plan 标题 */
  title?: string;
  /** :::artifact 属性 */
  artifactType?: string;
  artifactId?: string;
  /** :::diff 目标节点 */
  diffTarget?: string;
  /** 表格行(首行为表头) */
  rows?: string[][];
  /** :::plan 任务项 */
  planItems?: { checked: boolean; text: string }[];
}

/** 解析 ::: 块属性串 type="a" id="b" → { type:"a", id:"b" } */
function parseAttrs(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out[m[1]] = m[2];
  return out;
}

function parseBlocks(src: string): Block[] {
  const lines = src.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 代码块(mermaid 由渲染层特判)
    if (line.trimStart().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        body.push(lines[i]);
        i++;
      }
      i++;
      blocks.push({ type: "code", lang, text: body.join("\n") });
      continue;
    }
    // 扩展块 :::callout / :::plan / :::artifact / :::diff …(:::)
    const fence = line.trim().match(/^:::(\w+)(\{.*\})?\s*$/);
    if (fence) {
      const kind = fence[1];
      const attrs = parseAttrs(fence[2] ?? "");
      const body: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() !== ":::") {
        body.push(lines[i]);
        i++;
      }
      i++; // 跳过闭合 :::
      if (kind === "callout") {
        blocks.push({ type: "callout", calloutType: attrs.type, text: body.join("\n") });
      } else if (kind === "plan") {
        const planItems = body
          .filter((l) => /^\s*[-*]\s*\[[ x]\]/.test(l))
          .map((l) => ({ checked: /^\s*[-*]\s*\[x\]/.test(l), text: l.replace(/^\s*[-*]\s*\[[ x]\]\s*/, "") }));
        blocks.push({ type: "plan", title: attrs.title, text: body.join("\n"), planItems });
      } else if (kind === "artifact") {
        blocks.push({ type: "artifact", artifactType: attrs.type ?? "proposal", artifactId: attrs.id ?? "", title: attrs.title, text: body.join("\n") });
      } else if (kind === "diff") {
        blocks.push({ type: "diff", diffTarget: attrs.target ?? "", text: body.join("\n") });
      } else {
        // 未知扩展块降级为普通段落
        blocks.push({ type: "p", text: body.join("\n") || line });
      }
      continue;
    }
    // 表格(GFM):| a | b | 行 + |---|---| 分隔行 + 数据行
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const cells = lines[i].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        // 跳过分隔行 |---|---|
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      if (rows.length) blocks.push({ type: "table", text: "", rows });
      continue;
    }
    // 标题
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      blocks.push({ type: "heading", level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    // 任务列表
    if (/^\s*[-*] \[[ x]\]/.test(line)) {
      const items: string[] = [];
      const checked: boolean[] = [];
      while (i < lines.length && /^\s*[-*] \[[ x]\]/.test(lines[i])) {
        const m = lines[i].match(/^\s*[-*] \[([ x])\]\s*(.*)$/)!;
        checked.push(m[1] === "x");
        items.push(m[2]);
        i++;
      }
      blocks.push({ type: "tasklist", text: "", items, checked });
      continue;
    }
    // 普通列表
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push({ type: "ul", text: "", items });
      continue;
    }
    if (line.trim()) blocks.push({ type: "p", text: line });
    i++;
  }
  return blocks;
}

/** 行内渲染:**bold** / `code` / @ref chips;纯文本节点由 React 自动转义,不渲染原始 HTML */
function Inline({ text }: { text: string }) {
  const parts = useMemo(() => {
    return text.split(/(\*\*[^*]+\*\*|`[^`]+`|@(?:page|frame|node|revision|proposal)\([^)]+\)|#skill\([^)]+\)|\/style\([^)]+\))/g);
  }, [text]);
  return (
    <>
      {parts.map((p, i) => {
        if (/^\*\*[^*]+\*\*$/.test(p)) return <strong key={i}>{p.slice(2, -2)}</strong>;
        if (/^`[^`]+`$/.test(p)) return <code key={i} className="rounded bg-muted px-1 text-[0.9em]">{p.slice(1, -1)}</code>;
        const chip = p.match(/@(page|frame|node|revision|proposal)\(([^)]+)\)|#skill\(([^)]+)\)|\/style\(([^)]+)\)/);
        if (chip) {
          const kind = chip[1] ?? (chip[3] ? "skill" : "style");
          const id = chip[2] ?? chip[3] ?? chip[4];
          return (
            <button
              key={i}
              className="mx-0.5 rounded-full bg-primary/10 px-2 py-0.5 align-middle text-[0.85em] text-primary hover:bg-primary/20"
              onClick={() => (window as unknown as { __locateRef?: (kind: string, id: string) => void }).__locateRef?.(kind, id)}
              title={`定位 ${kind}:${id}`}
            >
              {kind}:{id}
            </button>
          );
        }
        return <span key={i}>{p}</span>;
      })}
    </>
  );
}

/** 轻量消毒 mermaid 产出的 SVG:移除 script 节点与 on* 事件属性(双保险,mermaid 已设 strict) */
function sanitizeSvg(svg: string): string {
  try {
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    doc.querySelectorAll("script").forEach((el) => el.remove());
    doc.querySelectorAll("*").forEach((el) => {
      for (const attr of [...el.attributes]) {
        if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
        if (/^href$/i.test(attr.name) && !attr.value.startsWith("#")) el.removeAttribute(attr.name);
      }
    });
    return new XMLSerializer().serializeToString(doc.documentElement);
  } catch {
    return "";
  }
}

/** Mermaid 图表:动态 import,渲染失败降级为源码(§14.6.7);securityLevel=strict + 输出消毒 */
function MermaidBlock({ text }: { text: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // useId 生成稳定 DOM id(避免渲染期调用 Math.random 的不纯)
  const rawId = useId();
  const idRef = useRef(`mmd_${rawId.replace(/[^a-zA-Z0-9]/g, "")}`);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
        const { svg: out } = await mermaid.render(idRef.current, text);
        if (alive) setSvg(sanitizeSvg(out));
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [text]);
  if (failed || !svg) {
    return <CodeBlock text={text} lang="mermaid(图表渲染失败,显示源码)" />;
  }
  return (
    <div
      className="overflow-x-auto rounded-md border bg-background p-2 [&_svg]:mx-auto [&_svg]:max-w-full"
      // mermaid strict 模式产出的 SVG;输入来自 Agent 的图表语法,非用户可控 HTML
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function CodeBlock({ text, lang }: { text: string; lang?: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  /** §14.6.6 应用为 Proposal:经 Agent 桥转为 Proposal,不直接修改正式设计 */
  const applyAsProposal = () => {
    const w = window as unknown as { __sendPrompt?: (prompt: string, opts?: { mode?: string; autoSend?: boolean }) => void };
    w.__sendPrompt?.(
      `请把以下代码应用为 Proposal(先校验 Catalog 兼容,不直接提交):\n\`\`\`${lang ?? ""}\n${text}\n\`\`\``,
      { mode: "repair_design", autoSend: true },
    );
  };
  return (
    <div className="rounded-md border text-[0.85em]">
      <div className="flex items-center justify-between bg-muted/50 px-2 py-1">
        <button className="inline-flex items-center gap-1 text-muted-foreground" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          {lang || "code"} · {text.split("\n").length} 行(默认折叠)
        </button>
        <div className="flex items-center gap-2">
          <button
            className="inline-flex items-center gap-1 text-muted-foreground hover:text-primary"
            onClick={applyAsProposal}
            title="经 Agent 生成 Proposal(不直接修改设计)"
          >
            <Wand2 className="size-3" /> 应用为 Proposal
          </button>
          <button
            className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
            onClick={() => {
              void navigator.clipboard.writeText(text);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />} {copied ? "已复制" : "复制"}
          </button>
        </div>
      </div>
      {open && (
        <pre className="overflow-x-auto p-2 font-mono text-[0.9em]">
          <code>{text}</code>
        </pre>
      )}
    </div>
  );
}

const CALLOUT_STYLE: Record<string, string> = {
  info: "border-blue-300 bg-blue-50/60 dark:bg-blue-950/30",
  success: "border-emerald-300 bg-emerald-50/60 dark:bg-emerald-950/30",
  warning: "border-amber-300 bg-amber-50/60 dark:bg-amber-950/30",
  danger: "border-red-300 bg-red-50/60 dark:bg-red-950/30",
  recommendation: "border-violet-300 bg-violet-50/60 dark:bg-violet-950/30",
};

const locateRef = (kind: string, id: string) =>
  (window as unknown as { __locateRef?: (kind: string, id: string) => void }).__locateRef?.(kind, id);

export function MarkdownLite({ source }: { source: string }) {
  const blocks = useMemo(() => {
    try {
      return parseBlocks(source);
    } catch {
      return [{ type: "p" as const, text: source }];
    }
  }, [source]);
  return (
    <div className="space-y-1.5 text-xs leading-relaxed">
      {blocks.map((b, i) => {
        switch (b.type) {
          case "heading":
            return <div key={i} className={`font-semibold ${b.level === 1 ? "text-sm" : ""}`}><Inline text={b.text} /></div>;
          case "ul":
            return (
              <ul key={i} className="list-disc pl-4">
                {b.items!.map((it, j) => <li key={j}><Inline text={it} /></li>)}
              </ul>
            );
          case "tasklist":
            return (
              <ul key={i} className="space-y-0.5">
                {b.items!.map((it, j) => (
                  <li key={j} className="flex items-start gap-1.5">
                    <span>{b.checked![j] ? "☑" : "☐"}</span>
                    <span className={b.checked![j] ? "text-muted-foreground line-through" : ""}><Inline text={it} /></span>
                  </li>
                ))}
              </ul>
            );
          case "table":
            return (
              <div key={i} className="overflow-x-auto rounded-md border">
                <table className="w-full border-collapse text-[0.9em]">
                  <thead>
                    <tr className="bg-muted/50">
                      {b.rows![0].map((c, j) => <th key={j} className="border-b px-2 py-1 text-left font-medium"><Inline text={c} /></th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows!.slice(1).map((r, j) => (
                      <tr key={j} className="border-b last:border-b-0">
                        {r.map((c, k) => <td key={k} className="px-2 py-1 align-top"><Inline text={c} /></td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "code":
            return b.lang === "mermaid" ? <MermaidBlock key={i} text={b.text} /> : <CodeBlock key={i} text={b.text} lang={b.lang} />;
          case "callout":
            return (
              <div key={i} className={`rounded-md border p-2 ${CALLOUT_STYLE[b.calloutType ?? "info"] ?? CALLOUT_STYLE.info}`}>
                <Inline text={b.text} />
              </div>
            );
          case "plan":
            return (
              <div key={i} className="rounded-md border border-indigo-200 bg-indigo-50/40 p-2 dark:border-indigo-800 dark:bg-indigo-950/20">
                <div className="mb-1 flex items-center gap-1.5 font-medium">📋 {b.title || "Plan"}</div>
                <ul className="space-y-0.5">
                  {(b.planItems ?? []).map((it, j) => (
                    <li key={j} className="flex items-start gap-1.5">
                      <span>{it.checked ? "☑" : "☐"}</span>
                      <span className={it.checked ? "text-muted-foreground line-through" : ""}><Inline text={it.text} /></span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          case "artifact":
            return (
              <div key={i} className="flex items-center gap-2 rounded-md border border-violet-200 bg-violet-50/40 p-2 dark:border-violet-800 dark:bg-violet-950/20">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">📦 {b.title || b.artifactId || "产物"}</div>
                  <div className="text-[10px] text-muted-foreground">{b.artifactType} · {b.artifactId}</div>
                </div>
                <button
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 hover:bg-muted"
                  onClick={() => locateRef(b.artifactType ?? "proposal", b.artifactId ?? "")}
                >
                  <Locate className="size-3" /> 查看/定位
                </button>
              </div>
            );
          case "diff":
            return (
              <div key={i} className="rounded-md border border-amber-200 bg-amber-50/40 p-2 dark:border-amber-800 dark:bg-amber-950/20">
                <div className="mb-1 flex items-center justify-between">
                  <span className="font-medium">🔀 Diff · {b.diffTarget}</span>
                  <button
                    className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 hover:bg-muted"
                    onClick={() => locateRef("node", b.diffTarget ?? "")}
                  >
                    <Locate className="size-3" /> 定位
                  </button>
                </div>
                <div className="whitespace-pre-wrap text-muted-foreground"><Inline text={b.text} /></div>
              </div>
            );
          default:
            return <p key={i}><Inline text={b.text} /></p>;
        }
      })}
    </div>
  );
}
