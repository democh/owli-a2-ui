import { generateProject, validateGeneratedFiles, type GeneratedFile } from "./codegen/codegen";
import { generateVueProject, validateVueFiles } from "./codegen/templates/vue-template";
import { runBuildGate, type BuildGateIssue, type BuildGateStep } from "./gate";
import type { DeviceId } from "@contracts/a2ui";
import type { IRDocument } from "@contracts/design-ir";

/**
 * 导出构建任务队列(M5-1):完整门禁(tsc/vite build)是分钟级操作,
 * 以内存任务 + 轮询接口执行,避免导出 mutation 被阻塞。
 * 单进程串行(并发 1)保证 SQLite 与磁盘产物写入安全;任务记录保留最近 50 条。
 */

export type ExportJobStatus = "queued" | "running" | "passed" | "failed";

export interface ExportJob {
  id: string;
  projectId: number;
  revision: number;
  adapterId: string;
  projectName: string;
  status: ExportJobStatus;
  /** 语法/结构层未映射报告(codegen) */
  unmapped: { surfaceId: string; type: string }[];
  /** 完整门禁结果 */
  issues: BuildGateIssue[];
  steps: BuildGateStep[];
  durationMs?: number;
  exportId?: string;
  fileCount?: number;
  error?: string;
  createdAt: number;
  finishedAt?: number;
}

interface JobSpec {
  projectId: number;
  revision: number;
  adapterId: string;
  projectName: string;
  doc: IRDocument;
  pages: { surfaceId: string; title: string; device: DeviceId }[];
  files: GeneratedFile[];
}

interface InternalJob extends ExportJob {
  spec?: JobSpec;
}

const jobs = new Map<string, InternalJob>();
const queue: string[] = [];
let draining = false;
/** 完成产物落盘的回调(exports 路由注入:zip + export_files 登记) */
let finalize: ((job: ExportJob, files: GeneratedFile[]) => Promise<string>) | null = null;

/** 注入产物落盘回调(zip 写盘 + export_files 登记,返回 exportId) */
export function setFinalizer(fn: (job: ExportJob, files: GeneratedFile[]) => Promise<string>): void {
  finalize = fn;
}

function newId(): string {
  return `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 入队一个完整构建任务;返回 jobId 供轮询。
 * codegen(纯同步)在入队时执行,语法门禁失败直接拒绝入队抛错。
 */
export function enqueueBuildJob(spec: Omit<JobSpec, "files">): string {
  // vue3(experimental):生成 Vue 3 SFC 工程;其余适配器走 React codegen
  const isVue = spec.adapterId === "vue3";
  const { files, unmapped } = isVue
    ? generateVueProject({ projectName: spec.projectName, doc: spec.doc, pages: spec.pages, adapterId: spec.adapterId })
    : generateProject({
        projectName: spec.projectName,
        doc: spec.doc,
        pages: spec.pages,
        adapterId: spec.adapterId,
      });
  const syntaxErrors = isVue ? validateVueFiles(files) : validateGeneratedFiles(files);
  if (syntaxErrors.length > 0) {
    throw new Error(`导出语法门禁失败: ${syntaxErrors.map((e) => `${e.path}: ${e.message}`).join("; ").slice(0, 300)}`);
  }
  const id = newId();
  const job: InternalJob = {
    id,
    projectId: spec.projectId,
    revision: spec.revision,
    adapterId: spec.adapterId,
    projectName: spec.projectName,
    status: "queued",
    unmapped,
    issues: [],
    steps: [],
    createdAt: Date.now(),
    spec: { ...spec, files },
  };
  jobs.set(id, job);
  queue.push(id);
  drain();
  return id;
}

export function getBuildJob(id: string): ExportJob | undefined {
  return jobs.get(id);
}

/** 串行消费队列 */
function drain(): void {
  if (draining) return;
  const id = queue.shift();
  if (!id) return;
  const job = jobs.get(id);
  if (!job) return;
  draining = true;
  job.status = "running";
  processJob(job)
    .catch((e) => {
      job.status = "failed";
      job.error = (e as Error).message.slice(0, 500);
      job.finishedAt = Date.now();
    })
    .finally(() => {
      draining = false;
      // 防内存膨胀:仅保留最近 50 条
      const all = [...jobs.entries()].sort((a, b) => b[1].createdAt - a[1].createdAt);
      for (const [k] of all.slice(50)) jobs.delete(k);
      drain();
    });
}

async function processJob(job: InternalJob): Promise<void> {
  const startedAt = Date.now();
  const spec = job.spec;
  if (!spec) throw new Error("任务规格丢失");
  try {
    // 完整构建门禁:tsc --noEmit → vite build(依赖宿主 node_modules 复用)
    // vue3(experimental):跳过 tsc 层,SFC 产物由 vite build 保证
    const gate = await runBuildGate(spec.files, { framework: job.adapterId === "vue3" ? "vue" : "react" });
    job.issues = gate.issues;
    job.steps = gate.steps;
    job.durationMs = gate.durationMs;
    if (!gate.passed) {
      job.status = "failed";
      job.error = gate.issues.find((i) => i.severity === "error")?.message.slice(0, 300);
      job.finishedAt = Date.now();
      return;
    }
    // 门禁通过 → zip 落盘 + export_files 登记(路由注入的 finalizer)
    if (!finalize) throw new Error("导出 finalizer 未注入");
    job.exportId = await finalize(job, spec.files);
    job.fileCount = spec.files.length;
    job.status = "passed";
    job.finishedAt = Date.now();
  } finally {
    job.spec = undefined; // 释放生成文件内存
  }
  void startedAt;
}
