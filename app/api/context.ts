import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import type { User } from "@db/schema";
import { findUserByUnionId, upsertUser } from "./queries/users";

export type TrpcContext = {
  req: Request;
  resHeaders: Headers;
  user?: User;
};

// 本地单机模式:无登录,所有请求都归属固定的本地用户
const LOCAL_UNION_ID = "local-user";
let localUser: User | undefined;

async function getLocalUser(): Promise<User | undefined> {
  if (!localUser) {
    await upsertUser({ unionId: LOCAL_UNION_ID, name: "本地用户" });
    localUser = await findUserByUnionId(LOCAL_UNION_ID);
  }
  return localUser;
}

/** 供非 tRPC 端点(如 SSE 流式接口)复用的本地用户鉴权 */
export async function requireLocalUser(): Promise<User> {
  const user = await getLocalUser();
  if (!user) throw new Error("本地用户初始化失败");
  return user;
}

export async function createContext(
  opts: FetchCreateContextFnOptions,
): Promise<TrpcContext> {
  const ctx: TrpcContext = { req: opts.req, resHeaders: opts.resHeaders };
  try {
    ctx.user = await getLocalUser();
  } catch {
    // 本地用户初始化失败时不阻塞请求,由 authed 中间件拦截
  }
  return ctx;
}
