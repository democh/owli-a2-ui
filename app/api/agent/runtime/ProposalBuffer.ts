import type { A2UIComponent, A2UIServerPayload } from "@contracts/a2ui-protocol";

/**
 * Proposal Buffer(文档 §5.2.5 / §14.2)
 *
 * 把流式 A2UI 消息转换为可提交的候选设计:
 * - 按 surfaceId 分组,保留消息顺序
 * - updateComponents 按 componentId last-write-wins 合并(保留首次出现顺序)
 * - updateDataModel 同路径合并
 * - 未闭合结构(root 不可达 / 引用悬空)禁止 flush → 不进入 Commit
 */

export interface BufferedSurface {
  surfaceId: string;
  title?: string;
  root?: string;
  components: Map<string, A2UIComponent>;
  dataModels: Map<string, { modelId: string; value: unknown }>;
  /** 消息序号(本地),用于顺序审计 */
  messageCount: number;
}

export class ProposalBuffer {
  private surfaces = new Map<string, BufferedSurface>();
  private closed = false;

  /** 收一条服务端 A2UI 消息;非法引用不抛错(流式允许前向引用),由 closure 检查兜底 */
  push(message: A2UIServerPayload): void {
    if (this.closed) throw new Error("ProposalBuffer 已关闭,不能再接收消息");
    switch (message.kind) {
      case "createSurface": {
        const s = this.ensure(message.surfaceId);
        if (message.root) s.root = message.root;
        if (message.title !== undefined) s.title = message.title;
        s.messageCount++;
        break;
      }
      case "updateComponents": {
        const s = this.ensure(message.surfaceId);
        for (const c of message.components) {
          s.components.set(c.id, c); // last-write-wins
        }
        if (message.batchEnd) this.batchEnded = true;
        s.messageCount++;
        break;
      }
      case "updateDataModel": {
        const s = this.ensure(message.surfaceId);
        s.dataModels.set(message.modelId, { modelId: message.modelId, value: message.value });
        s.messageCount++;
        break;
      }
      case "deleteSurface": {
        this.surfaces.delete(message.surfaceId);
        break;
      }
      default:
        break;
    }
  }

  private batchEnded = false;

  private ensure(surfaceId: string): BufferedSurface {
    let s = this.surfaces.get(surfaceId);
    if (!s) {
      s = {
        surfaceId,
        components: new Map(),
        dataModels: new Map(),
        messageCount: 0,
      };
      this.surfaces.set(surfaceId, s);
    }
    return s;
  }

  get surfaceIds(): string[] {
    return [...this.surfaces.keys()];
  }

  getSurface(surfaceId: string): BufferedSurface | undefined {
    return this.surfaces.get(surfaceId);
  }

  /** 显式 batch_end(文档 flush 触发条件之一) */
  markBatchEnd(): void {
    this.batchEnded = true;
  }

  /**
   * 闭合性检查:每个 surface 必须有 root,且所有组件从 root 可达、无悬空引用。
   * 返回问题列表;非空则禁止进入 Commit(可继续等消息或进入修复)。
   */
  closureIssues(): string[] {
    const issues: string[] = [];
    for (const s of this.surfaces.values()) {
      if (s.components.size === 0) {
        issues.push(`surface "${s.surfaceId}" 没有任何组件`);
        continue;
      }
      const root = s.root ?? [...s.components.keys()][0];
      if (!root || !s.components.has(root)) {
        issues.push(`surface "${s.surfaceId}" 的 root "${root}" 不存在`);
        continue;
      }
      const reachable = new Set<string>();
      const walk = (id: string, stack: string[]) => {
        if (stack.includes(id)) {
          issues.push(`surface "${s.surfaceId}" 存在循环引用: ${[...stack, id].join(" → ")}`);
          return;
        }
        const node = s.components.get(id);
        if (!node) {
          issues.push(`surface "${s.surfaceId}" 引用了不存在的组件 "${id}"`);
          return;
        }
        if (reachable.has(id)) return;
        reachable.add(id);
        node.children.forEach((c) => walk(c, [...stack, id]));
      };
      walk(root, []);
      for (const id of s.components.keys()) {
        if (!reachable.has(id)) issues.push(`surface "${s.surfaceId}" 组件 "${id}" 不可达`);
      }
    }
    return issues;
  }

  /** 是否满足 flush 条件:显式 batch_end 或 全部闭合 */
  readyToFlush(): boolean {
    return this.batchEnded || this.closureIssues().length === 0;
  }

  close(): void {
    this.closed = true;
  }
}
