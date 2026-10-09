import { useMemo } from "react";
import type { PageState } from "@/stores/workspaceStore";

/**
 * 画布 Minimap(文档 §7.2)
 *
 * 按内容总包围盒归一化渲染页面色块与当前视口框;点击/拖动跳转视口。
 * 纯展示组件:视口矩形与跳转回调由 CanvasStage 提供。
 */

export interface ViewportRect {
  /** 内容坐标(未缩放) */
  left: number;
  top: number;
  width: number;
  height: number;
}

const W = 176;
const H = 116;
const PAD = 8;

export function CanvasMinimap({
  pages,
  viewport,
  onJump,
}: {
  pages: PageState[];
  viewport: ViewportRect | null;
  onJump: (cx: number, cy: number) => void;
}) {
  const bounds = useMemo(() => {
    if (!pages.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pages) {
      minX = Math.min(minX, p.posX);
      minY = Math.min(minY, p.posY);
      maxX = Math.max(maxX, p.posX + p.width);
      maxY = Math.max(maxY, p.posY + p.height + 34);
    }
    // 视口也纳入包围盒,保证视口框始终可见
    if (viewport) {
      minX = Math.min(minX, viewport.left);
      minY = Math.min(minY, viewport.top);
      maxX = Math.max(maxX, viewport.left + viewport.width);
      maxY = Math.max(maxY, viewport.top + viewport.height);
    }
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    const scale = Math.min((W - PAD * 2) / w, (H - PAD * 2) / h);
    return { minX, minY, w, h, scale, ox: (W - w * scale) / 2, oy: (H - h * scale) / 2 };
  }, [pages, viewport]);

  if (!bounds) return null;
  const toPx = (x: number, y: number) => ({
    x: bounds.ox + (x - bounds.minX) * bounds.scale,
    y: bounds.oy + (y - bounds.minY) * bounds.scale,
  });

  const handle = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const cx = (px - bounds.ox) / bounds.scale + bounds.minX;
    const cy = (py - bounds.oy) / bounds.scale + bounds.minY;
    onJump(cx, cy);
  };

  return (
    <svg
      width={W}
      height={H}
      onClick={handle}
      data-no-deselect
      className="pointer-events-auto cursor-pointer rounded-md border border-neutral-200 bg-white/95 shadow-md"
      aria-label="画布缩略图"
    >
      {pages.map((p) => {
        const a = toPx(p.posX, p.posY);
        const b = toPx(p.posX + p.width, p.posY + p.height + 34);
        return (
          <g key={p.id}>
            <rect
              x={a.x}
              y={a.y}
              width={Math.max(2, b.x - a.x)}
              height={Math.max(2, b.y - a.y)}
              rx={2}
              className="fill-indigo-100 stroke-indigo-300"
              strokeWidth={1}
            />
            <text x={a.x + 2} y={a.y + 8} fontSize={7} className="fill-neutral-500">
              {p.title.slice(0, 8)}
            </text>
          </g>
        );
      })}
      {viewport && (
        (() => {
          const a = toPx(viewport.left, viewport.top);
          const b = toPx(viewport.left + viewport.width, viewport.top + viewport.height);
          return (
            <rect
              x={a.x}
              y={a.y}
              width={Math.max(3, b.x - a.x)}
              height={Math.max(3, b.y - a.y)}
              rx={2}
              className="fill-indigo-500/10 stroke-indigo-500"
              strokeWidth={1.5}
            />
          );
        })()
      )}
    </svg>
  );
}
