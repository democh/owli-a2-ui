import { z } from "zod";
import { authedQuery, createRouter } from "../middleware";
import { assertProjectRole } from "../queries/projects";
import { loadHead, commitRunChanges } from "../command/commandService";
import { tsxFilesToSurfaces } from "../import/tsx-importer";
import { surfacesToFrameOps } from "../import/frame-ops";
/**
 * imports 路由(M5.3 TSX Importer):React TSX → Design IR,复用既有提交链路。
 * 每个文件一个 surface(addFrame op),与 Run 提交同事务语义:
 * baseRevision 校验 + inverseOps 可撤销 + PageBoard/Frame 同步落库 + Import Report。
 */

const fileSchema = z.object({
  name: z.string().min(1).max(120).regex(/^[^\\/:*?"<>|]+$/, "文件名含非法字符"),
  content: z.string().min(1).max(512 * 1024),
});

export const importsRouter = createRouter({
  /** 导入 TSX 文件集(粘贴或上传解析后的文本)并提交为新 revision */
  create: authedQuery
    .input(
      z.object({
        projectId: z.number(),
        baseRevision: z.number().int().nonnegative(),
        files: z.array(fileSchema).min(1).max(50),
        device: z.enum(["desktop", "tablet", "mobile"]).default("desktop"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertProjectRole(ctx.user.id, input.projectId, "editor"); // RBAC:editor 才能导入(Import 矩阵)
      const head = loadHead(input.projectId);
      if (!head) throw new Error("项目还没有 Design IR");
      if (head.revision !== input.baseRevision) {
        throw new Error(`Revision 冲突:当前 head=${head.revision},请刷新后重试`);
      }

      const { surfaces, report } = tsxFilesToSurfaces(
        input.files.map((f) => ({ name: f.name, content: f.content })),
      );

      const { ops, boards, frames } = surfacesToFrameOps(surfaces, input.device);

      const result = commitRunChanges({
        projectId: input.projectId,
        baseRevision: input.baseRevision,
        ops,
        scope: {},
        provenance: {
          actorType: "user",
          actorId: String(ctx.user.id),
          promptVersion: "import-v1",
        },
        boards,
        frames,
      });

      return { revision: result.revision, batchId: result.batchId, report };
    }),
});
