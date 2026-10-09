import { z } from "zod";
import { authedQuery, createRouter } from "../middleware";
import { assertProjectRole } from "../queries/projects";
import { commitOpsBatch, loadHead } from "../command/commandService";

/**
 * M7 组件定义/实例:前端创建入口。
 * - defineComponent:把选中节点子树提取为组件定义(存入 IR componentDefs)
 * - insertInstance:在页面 root 下插入一个 instanceOf 实例节点
 *   (读侧 resolveInstances 展开后,画布/导出无需感知实例)
 * 均走 commitOpsBatch 既有链路(baseRevision 校验 + inverseOps 可撤销)。
 */

export const designDefsRouter = createRouter({
  /** 把选中节点子树定义为组件 */
  define: authedQuery
    .input(
      z.object({
        projectId: z.number(),
        surfaceId: z.string(),
        rootId: z.string(),
        defId: z.string().max(60).regex(/^[a-z0-9][a-z0-9_-]*$/i, "定义 id 仅允许字母/数字/下划线/连字符").optional(),
        name: z.string().min(1).max(40),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertProjectRole(ctx.user.id, input.projectId, "editor");
      const head = loadHead(input.projectId);
      if (!head) throw new Error("项目还没有 Design IR");
      const node = head.doc.surfaces[input.surfaceId]?.components[input.rootId];
      if (!node) throw new Error("选中的组件不存在,请重新选择");
      const defId = input.defId ?? `def_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const result = commitOpsBatch({
        projectId: input.projectId,
        baseRevision: head.revision,
        ops: [{
          op: "defineComponent",
          defId,
          name: input.name,
          surfaceId: input.surfaceId,
          rootId: input.rootId,
        } as never],
        scope: {},
        provenance: { actorType: "user", actorId: String(ctx.user.id), promptVersion: "component-def" },
      });
      return { revision: result.revision, defId };
    }),

  /** 可插入的组件定义清单(当前 head 的 componentDefs) */
  list: authedQuery
    .input(z.object({ projectId: z.number() }))
    .query(async ({ input }) => {
      const head = loadHead(input.projectId);
      if (!head) return [];
      return Object.values(head.doc.componentDefs ?? {}).map((d) => ({
        defId: d.id,
        name: d.name || d.id,
        rootType: d.components[d.root]?.type ?? "Col",
      }));
    }),

  /** 在页面 root 下插入一个组件实例 */
  insertInstance: authedQuery
    .input(
      z.object({
        projectId: z.number(),
        surfaceId: z.string(),
        instanceOf: z.string().min(1),
        title: z.string().max(60).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertProjectRole(ctx.user.id, input.projectId, "editor");
      const head = loadHead(input.projectId);
      if (!head) throw new Error("项目还没有 Design IR");
      const def = head.doc.componentDefs?.[input.instanceOf];
      if (!def) throw new Error("组件定义不存在");
      const surface = head.doc.surfaces[input.surfaceId];
      if (!surface) throw new Error("目标页面不存在");
      const rootType = def.components[def.root]?.type ?? "Col";
      const instanceId = `inst_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const props = input.title ? { title: input.title } : {};
      const result = commitOpsBatch({
        projectId: input.projectId,
        baseRevision: head.revision,
        ops: [{
          op: "addNode",
          surfaceId: input.surfaceId,
          parentId: surface.root,
          id: instanceId,
          node: { type: rootType, props, children: [], instanceOf: input.instanceOf },
          extra: {},
        } as never],
        scope: {},
        provenance: { actorType: "user", actorId: String(ctx.user.id), promptVersion: `instance:${input.instanceOf}` },
      });
      return { revision: result.revision, instanceId };
    }),
});
