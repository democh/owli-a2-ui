/**
 * 轻量 Markdown 渲染器(零依赖,覆盖 AI 回复常用语法)
 * 支持:**粗体**、`行内代码`、```代码块```、- 无序列表、1. 有序列表、[链接](url)、标题、换行
 * 全部经 React 节点渲染,无 dangerouslySetInnerHTML,天然防 XSS
 */
import { memo, type ReactNode } from "react";

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // 依次匹配:代码 / 粗体 / 链接
  const re = /(`[^`\n]+`)|(\*\*[^*]+\*\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith("`")) {
      nodes.push(
        <code key={`${keyPrefix}-${i}`} className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-[12px] text-indigo-700">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      nodes.push(
        <strong key={`${keyPrefix}-${i}`} className="font-semibold text-neutral-900">
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      const label = token.slice(1, token.indexOf("]"));
      const url = token.slice(token.indexOf("](") + 2, -1);
      nodes.push(
        <a key={`${keyPrefix}-${i}`} href={url} target="_blank" rel="noreferrer"
          className="text-indigo-600 underline underline-offset-2 hover:text-indigo-500">
          {label}
        </a>,
      );
    }
    last = m.index + token.length;
    i++;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const blocks: ReactNode[] = [];
  // 先按代码块切分
  const segments = text.split(/```(\w*)\n?([\s\S]*?)(?:```|$)/);
  // segments: [文本, lang, code, 文本, lang, code, ...]
  let bi = 0;
  for (let s = 0; s < segments.length; s += 3) {
    const plain = segments[s];
    const lang = segments[s + 1];
    const code = segments[s + 2];

    if (plain) {
      const lines = plain.split("\n");
      let listBuffer: { ordered: boolean; items: string[] } | null = null;
      const flushList = () => {
        if (!listBuffer) return;
        const { ordered, items } = listBuffer;
        blocks.push(
          ordered ? (
            <ol key={`l-${bi++}`} className="ml-4 list-decimal space-y-1">
              {items.map((it, i) => <li key={i}>{renderInline(it, `li-${bi}-${i}`)}</li>)}
            </ol>
          ) : (
            <ul key={`l-${bi++}`} className="ml-4 list-disc space-y-1">
              {items.map((it, i) => <li key={i}>{renderInline(it, `li-${bi}-${i}`)}</li>)}
            </ul>
          ),
        );
        listBuffer = null;
      };
      for (const line of lines) {
        const ul = line.match(/^\s*[-•]\s+(.*)$/);
        const ol = line.match(/^\s*\d+[.、]\s+(.*)$/);
        if (ul || ol) {
          const ordered = !!ol;
          const item = (ul?.[1] ?? ol?.[1]) ?? "";
          if (!listBuffer || listBuffer.ordered !== ordered) {
            flushList();
            listBuffer = { ordered, items: [] };
          }
          listBuffer.items.push(item);
          continue;
        }
        flushList();
        const heading = line.match(/^(#{1,3})\s+(.*)$/);
        if (heading) {
          blocks.push(
            <div key={`h-${bi++}`} className={`font-semibold text-neutral-900 ${heading[1].length === 1 ? "text-base" : "text-sm"}`}>
              {renderInline(heading[2], `h-${bi}`)}
            </div>,
          );
        } else if (line.trim() === "") {
          blocks.push(<div key={`sp-${bi++}`} className="h-2" />);
        } else {
          blocks.push(<p key={`p-${bi++}`}>{renderInline(line, `p-${bi}`)}</p>);
        }
      }
      flushList();
    }

    if (code !== undefined) {
      blocks.push(
        <pre key={`c-${bi++}`} className="overflow-x-auto rounded-lg bg-neutral-900 p-3 font-mono text-[12px] leading-relaxed text-neutral-100">
          {lang && <div className="mb-1.5 text-[10px] uppercase tracking-wider text-neutral-500">{lang}</div>}
          <code>{code.replace(/\n$/, "")}</code>
        </pre>,
      );
    }
  }

  return (
    <div className="flex flex-col gap-1">
      {blocks}
      {streaming && <span className="ml-0.5 inline-block h-4 w-[7px] animate-pulse rounded-[2px] bg-indigo-500 align-text-bottom" />}
    </div>
  );
});
