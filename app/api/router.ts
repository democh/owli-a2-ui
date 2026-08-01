import { authRouter } from "./auth-router";
import { createRouter, publicQuery } from "./middleware";
import { chatRouter, pagesRouter, projectsRouter, settingsRouter, statsRouter, versionsRouter } from "./routers/studio";
import { publishRouter } from "./routers/publish";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  auth: authRouter,
  projects: projectsRouter,
  pages: pagesRouter,
  versions: versionsRouter,
  settings: settingsRouter,
  chat: chatRouter,
  publish: publishRouter,
  stats: statsRouter,
});

export type AppRouter = typeof appRouter;
