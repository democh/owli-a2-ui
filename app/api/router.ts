import { authRouter } from "./auth-router";
import { createRouter, publicQuery } from "./middleware";
import { chatRouter, pagesRouter, projectsRouter, settingsRouter, statsRouter, versionsRouter } from "./routers/studio";
import { publishRouter } from "./routers/publish";
import { runsRouter } from "./routers/runs";
import { workspaceRouter } from "./routers/workspace";
import { exportsRouter } from "./routers/exports";
import { importsRouter } from "./routers/imports";
import { templatesRouter } from "./routers/templates";
import { commentsRouter } from "./routers/comments";
import { skillsRouter } from "./routers/skills";
import { designDefsRouter } from "./routers/design-defs";
import { alertsRouter } from "./routers/alerts";
import { memoryRouter } from "./routers/memory";

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
  runs: runsRouter,
  workspace: workspaceRouter,
  exports: exportsRouter,
  imports: importsRouter,
  templates: templatesRouter,
  comments: commentsRouter,
  skills: skillsRouter,
  designDefs: designDefsRouter,
  alerts: alertsRouter,
  memory: memoryRouter,
});

export type AppRouter = typeof appRouter;
