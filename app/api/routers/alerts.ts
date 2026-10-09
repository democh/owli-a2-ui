import { z } from "zod";
import { authedQuery, createRouter } from "../middleware";
import { ackAlert, ackAllAlerts, listAlerts, unreadAlertCount } from "../observability/alerts";

/**
 * alerts 路由(M6 站内告警):登录用户可读/确认;无项目级 RBAC(告警为全局运维信号)。
 */
export const alertsRouter = createRouter({
  unreadCount: authedQuery.query(async () => ({ n: unreadAlertCount() })),

  list: authedQuery
    .input(z.object({ limit: z.number().int().min(1).max(100).default(30) }).nullish())
    .query(async ({ input }) => listAlerts(input?.limit ?? 30)),

  ack: authedQuery
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ input }) => {
      ackAlert(input.id);
      return { ok: true };
    }),

  ackAll: authedQuery.mutation(async () => {
    ackAllAlerts();
    return { ok: true };
  }),
});
