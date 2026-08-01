import type { ReactNode } from "react";
import type { ComponentNode, ThemeTokens } from "@contracts/a2ui";
import {
  Activity, Award, ArrowRight, BarChart3, Bell, Bookmark, Check, ChevronRight,
  Clock, Compass, Download, Eye, Flame, Gift, Globe, Grid3X3, Heart, Home,
  Image as ImageIcon, LineChart, Lock, Map, Menu, MessageCircle, Moon, Palette,
  Play, Plug, Plus, PlusCircle, Rocket, Search, Settings, Shield, ShoppingCart,
  Sparkles, Star, Target, TrendingUp, User, Users, Wallet, Zap, type LucideIcon,
} from "lucide-react";

// ---------------------------------------------------------------------------
// 渲染上下文
// ---------------------------------------------------------------------------
export interface RenderCtx {
  render: (id: string) => ReactNode;
  tokens: ThemeTokens;
}
export type ComponentRenderer = (node: ComponentNode, ctx: RenderCtx) => ReactNode;
export type RendererRegistry = Record<string, ComponentRenderer>;

// ---------------------------------------------------------------------------
// 图标
// ---------------------------------------------------------------------------
const ICON_MAP: Record<string, LucideIcon> = {
  activity: Activity, award: Award, "arrow-right": ArrowRight, chart: BarChart3,
  bell: Bell, bookmark: Bookmark, check: Check, "chevron-right": ChevronRight,
  clock: Clock, compass: Compass, download: Download, eye: Eye, flame: Flame,
  gift: Gift, globe: Globe, grid: Grid3X3, heart: Heart, home: Home,
  image: ImageIcon, "line-chart": LineChart, lock: Lock, map: Map, menu: Menu,
  message: MessageCircle, moon: Moon, palette: Palette, play: Play, plug: Plug,
  plus: Plus, "plus-circle": PlusCircle, rocket: Rocket, search: Search,
  settings: Settings, shield: Shield, "shopping-cart": ShoppingCart,
  sparkles: Sparkles, star: Star, target: Target, "trending-up": TrendingUp,
  user: User, users: Users, wallet: Wallet, zap: Zap,
};

export function A2Icon({ name, size = 18, className, style }: {
  name?: unknown; size?: number; className?: string; style?: React.CSSProperties;
}) {
  const Icon = ICON_MAP[String(name ?? "sparkles")] ?? Sparkles;
  return <Icon size={size} className={className} style={style} />;
}

// ---------------------------------------------------------------------------
// props 读取工具
// ---------------------------------------------------------------------------
export const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : v == null ? d : String(v));
export const num = (v: unknown, d = 0): number => (typeof v === "number" ? v : Number(v) || d);
export const bool = (v: unknown, d = false): boolean => (typeof v === "boolean" ? v : d);
export const arr = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
export const obj = <T = Record<string, unknown>>(v: unknown): T => (v && typeof v === "object" && !Array.isArray(v) ? (v as T) : ({} as T));

/**
 * 任意值 → 可渲染文本。
 * AI 生成 props 时字符串数组可能混入 {label,href} 等对象,直接渲染会让 React 崩溃,
 * 所有"字符串数组"类 props 必须经 strList 归一化后再渲染。
 */
export const textOf = (v: unknown, d = ""): string => {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    for (const k of ["label", "title", "text", "name", "value"]) {
      if (typeof o[k] === "string" && o[k]) return o[k] as string;
    }
    return d;
  }
  return d;
};

/** 归一化字符串数组(兼容字符串 / 数字 / {label,...} 对象混排) */
export const strList = (v: unknown): string[] => arr(v).map((x) => textOf(x)).filter((x) => x !== "");

/** 稳定伪随机(按字符串 seed) */
export function seeded(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export const GRADIENTS = [
  "linear-gradient(135deg,#667eea,#764ba2)",
  "linear-gradient(135deg,#f093fb,#f5576c)",
  "linear-gradient(135deg,#4facfe,#00f2fe)",
  "linear-gradient(135deg,#43e97b,#38f9d7)",
  "linear-gradient(135deg,#fa709a,#fee140)",
  "linear-gradient(135deg,#30cfd0,#330867)",
  "linear-gradient(135deg,#a8edea,#fed6e3)",
  "linear-gradient(135deg,#ff9a9e,#fecfef)",
];
export const gradientFor = (seed: string) => GRADIENTS[seeded(seed) % GRADIENTS.length];

// ---------------------------------------------------------------------------
// SVG 图表(bar / line / area / pie)
// ---------------------------------------------------------------------------
interface ChartProps {
  kind?: unknown; categories?: unknown; series?: unknown; height?: unknown; accent: string;
}
const PALETTE = ["#6366f1", "#22c55e", "#f59e0b", "#ec4899", "#06b6d4", "#8b5cf6"];

export function SvgChart({ kind = "bar", categories = [], series = [], height = 260, accent }: ChartProps) {
  const cats = strList(categories);
  const sers = arr<{ name?: string; data?: number[] }>(series).map((s) => ({
    name: str(s?.name, "系列"),
    data: arr<number>(s?.data),
  }));
  const h = num(height, 260);
  const w = 720;
  const padL = 40, padB = 28, padT = 16;
  const iw = w - padL - 16, ih = h - padT - padB;
  const max = Math.max(1, ...sers.flatMap((s) => s.data));
  const k = str(kind, "bar");
  const color = (i: number) => (i === 0 ? accent || PALETTE[0] : PALETTE[i % PALETTE.length]);

  if (!cats.length || !sers.length)
    return <div style={{ height: h }} className="flex items-center justify-center text-sm opacity-50">暂无数据</div>;

  const xStep = iw / cats.length;
  const y = (v: number) => padT + ih - (v / max) * ih;

  const gridLines = [0.25, 0.5, 0.75, 1].map((f) => (
    <line key={f} x1={padL} x2={w - 16} y1={padT + ih * (1 - f)} y2={padT + ih * (1 - f)} stroke="currentColor" strokeOpacity="0.08" />
  ));

  let body: ReactNode = null;
  if (k === "bar") {
    const groupW = xStep * 0.62;
    const barW = Math.min(38, groupW / sers.length - 4);
    body = sers.map((s, si) =>
      s.data.map((v, ci) => {
        const x = padL + ci * xStep + (xStep - groupW) / 2 + si * (barW + 4);
        return (
          <rect key={`${si}-${ci}`} x={x} y={y(v)} width={barW} height={padT + ih - y(v)} rx={4}
            fill={color(si)} opacity={0.92}>
            <title>{`${cats[ci]} · ${s.name}: ${v}`}</title>
          </rect>
        );
      }),
    );
  } else if (k === "pie") {
    const data = sers[0].data;
    const total = data.reduce((a, b) => a + b, 0) || 1;
    const cx = w / 2, cy = padT + ih / 2, r = Math.min(iw, ih) / 2 - 8;
    let angle = -Math.PI / 2;
    body = data.map((v, i) => {
      const a2 = angle + (v / total) * Math.PI * 2;
      const large = a2 - angle > Math.PI ? 1 : 0;
      const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
      const x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
      angle = a2;
      return (
        <path key={i} d={`M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} Z`}
          fill={color(i)} opacity={0.92}>
          <title>{`${cats[i]}: ${v}`}</title>
        </path>
      );
    });
  } else {
    // line / area
    body = sers.map((s, si) => {
      const pts = s.data.map((v, ci) => [padL + ci * xStep + xStep / 2, y(v)] as const);
      const path = pts.map(([x, yy], i) => `${i ? "L" : "M"}${x},${yy}`).join(" ");
      return (
        <g key={si}>
          {k === "area" && (
            <path d={`${path} L${pts[pts.length - 1]?.[0]},${padT + ih} L${pts[0]?.[0]},${padT + ih} Z`}
              fill={color(si)} opacity={0.14} />
          )}
          <path d={path} fill="none" stroke={color(si)} strokeWidth={2.5} strokeLinejoin="round" />
          {pts.map(([x, yy], i) => (
            <circle key={i} cx={x} cy={yy} r={3.5} fill="#fff" stroke={color(si)} strokeWidth={2}>
              <title>{`${cats[i]} · ${s.name}: ${s.data[i]}`}</title>
            </circle>
          ))}
        </g>
      );
    });
  }

  return (
    <div className="w-full overflow-hidden">
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height: h, color: "inherit" }}>
        {gridLines}
        {body}
        {k !== "pie" &&
          cats.map((c, i) => (
            <text key={i} x={padL + i * xStep + xStep / 2} y={h - 8} textAnchor="middle"
              fontSize={11} fill="currentColor" opacity={0.5}>{c}</text>
          ))}
      </svg>
      {sers.length > 1 && k !== "pie" && (
        <div className="flex gap-4 justify-center mt-1">
          {sers.map((s, i) => (
            <span key={i} className="flex items-center gap-1.5 text-xs" style={{ opacity: 0.7 }}>
              <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: color(i) }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      {k === "pie" && (
        <div className="flex flex-wrap gap-3 justify-center mt-1">
          {cats.map((c, i) => (
            <span key={i} className="flex items-center gap-1.5 text-xs" style={{ opacity: 0.7 }}>
              <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: color(i) }} />
              {c}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
