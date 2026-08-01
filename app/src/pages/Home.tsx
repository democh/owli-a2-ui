/**
 * 项目仪表盘
 */
import { useState } from "react";
import { useNavigate } from "react-router";
import { Layers, Plus, Sparkles, Trash2 } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { trpc } from "@/providers/trpc";
import { PRESET_IDS, STYLE_PRESETS, type PresetId } from "@contracts/a2ui";
import { gradientFor } from "@/components/renderer/shared";

export default function Home() {
  const { user, isLoading } = useAuth({ redirectOnUnauthenticated: true });
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const projectsQ = trpc.projects.list.useQuery(undefined, { enabled: !!user });
  const createMut = trpc.projects.create.useMutation({
    onSuccess: async (r) => {
      await utils.projects.list.invalidate();
      navigate(`/project/${r.id}`);
    },
  });
  const removeMut = trpc.projects.remove.useMutation({
    onSuccess: () => utils.projects.list.invalidate(),
  });

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [preset, setPreset] = useState<PresetId>("shadcn");

  if (isLoading || !user) {
    return (
      <div className="flex h-screen items-center justify-center bg-neutral-50">
        <div className="flex items-center gap-2 text-sm text-neutral-400">
          <Sparkles size={16} className="animate-pulse" /> 加载中…
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f7f8fa]">
      {/* 顶栏 */}
      <header className="sticky top-0 z-10 border-b border-neutral-200/70 bg-white/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-md shadow-indigo-200">
              <Layers size={16} />
            </span>
            <span className="text-[15px] font-bold tracking-tight">owli A2UI</span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        <div className="mb-8 flex items-end justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">我的项目</h1>
            <p className="mt-1 text-sm text-neutral-500">用一句话生成页面,在画布上自由排布、选中精修、一键换肤。</p>
          </div>
          <button
            onClick={() => setOpen(true)}
            className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-md shadow-indigo-200 transition hover:bg-indigo-500"
          >
            <Plus size={15} /> 新建项目
          </button>
        </div>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {(projectsQ.data ?? []).map((p) => (
            <div key={p.id}
              className="group cursor-pointer overflow-hidden rounded-2xl border border-neutral-200/80 bg-white transition hover:-translate-y-0.5 hover:shadow-[0_12px_40px_rgba(0,0,0,0.08)]"
              onClick={() => navigate(`/project/${p.id}`)}>
              <div className="relative flex h-36 items-center justify-center"
                style={{ background: gradientFor(p.name) }}>
                <span className="text-4xl font-black text-white/90">{p.name.slice(0, 1)}</span>
                <span className="absolute left-3 top-3 rounded-full bg-white/85 px-2 py-0.5 text-[10px] font-medium text-neutral-600">
                  {STYLE_PRESETS[p.preset as PresetId]?.label ?? p.preset}
                </span>
                <button
                  title="删除项目"
                  onClick={(e) => { e.stopPropagation(); if (confirm(`删除项目「${p.name}」?该操作不可恢复。`)) removeMut.mutate({ id: p.id }); }}
                  className="absolute right-3 top-3 rounded-full bg-white/85 p-1.5 text-neutral-400 opacity-0 transition group-hover:opacity-100 hover:text-red-500">
                  <Trash2 size={13} />
                </button>
              </div>
              <div className="p-4">
                <div className="truncate text-[15px] font-semibold">{p.name}</div>
                <div className="mt-1 text-xs text-neutral-400">
                  {p.pageCount} 个页面 · {new Date(p.updatedAt).toLocaleDateString("zh-CN")} 更新
                </div>
              </div>
            </div>
          ))}

          {/* 新建卡片 */}
          <button
            onClick={() => setOpen(true)}
            className="flex h-[212px] flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-neutral-200 text-neutral-400 transition hover:border-indigo-300 hover:text-indigo-500"
          >
            <Plus size={22} />
            <span className="text-sm">新建项目</span>
          </button>
        </div>
      </main>

      {/* 新建项目对话框 */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={() => setOpen(false)}>
          <div className="w-[440px] rounded-2xl bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold">新建项目</h2>
            <p className="mt-1 text-xs text-neutral-400">创建后会自动生成一个示例首页,直接在画布上开始。</p>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="项目名称,如:星轨咖啡官网"
              className="mt-5 w-full rounded-xl border border-neutral-200 px-3.5 py-2.5 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            />
            <div className="mt-4">
              <span className="text-xs font-medium text-neutral-500">默认风格预设</span>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {PRESET_IDS.map((id) => (
                  <button key={id}
                    onClick={() => setPreset(id)}
                    className={`rounded-xl border p-3 text-left transition ${
                      preset === id ? "border-indigo-400 bg-indigo-50/60" : "border-neutral-200 hover:border-neutral-300"
                    }`}>
                    <div className="text-sm font-semibold">{STYLE_PRESETS[id].label}</div>
                    <div className="mt-0.5 text-[11px] text-neutral-400">{STYLE_PRESETS[id].desc}</div>
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button onClick={() => setOpen(false)}
                className="rounded-xl px-4 py-2 text-sm text-neutral-500 transition hover:bg-neutral-100">取消</button>
              <button
                disabled={!name.trim() || createMut.isPending}
                onClick={() => createMut.mutate({ name: name.trim(), preset })}
                className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-40">
                {createMut.isPending ? "创建中…" : "创建"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
