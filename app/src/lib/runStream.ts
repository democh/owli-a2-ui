import type { AgentEvent } from "@contracts/agent";

/**
 * Run 事件流客户端(SSE):seq 去重 + 断线重连 + 重放恢复
 * (传输偏差记录:SSE + tRPC mutation 替代文档中的 WebSocket;seq 保序去重满足一致性)
 */

export interface RunStreamHandle {
  close: () => void;
}

export function openRunStream(
  runId: string,
  onEvent: (e: AgentEvent) => void,
  onDone?: () => void,
  onStale?: () => void,
): RunStreamHandle {
  let lastSeq = -1;
  let closed = false;
  let retry = 0;
  let everOpened = false; // 是否成功建立过连接(区分瞬断与永久失效)
  let es: EventSource | null = null;

  const connect = () => {
    if (closed) return;
    es = new EventSource(`/api/runs/${runId}/stream`);
    es.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as AgentEvent;
        if (event.seq <= lastSeq) return; // 去重按序应用
        lastSeq = event.seq;
        onEvent(event);
        const t = event.type;
        if (t === "design.explanation" || t === "run.cancelled" || t === "run.failed") {
          onDone?.();
          close(); // 终态后不再需要流
        }
      } catch {
        /* 忽略坏帧 */
      }
    };
    es.onerror = () => {
      es?.close();
      es = null;
      if (closed) return;
      // 从未成功建立(404 / 服务重启内存态丢失):run 已不可达,立即终止,避免重试刷屏
      if (!everOpened) {
        onStale?.();
        return;
      }
      // 断线重连:重连后服务端先重放缺失事件(seq 去重),再接实时流(最多 5 次,指数退避)
      if (retry >= 5) {
        onDone?.();
        return;
      }
      retry++;
      setTimeout(connect, Math.min(8000, 500 * 2 ** retry));
    };
    es.onopen = () => {
      retry = 0;
      everOpened = true;
    };
  };

  connect();
  function close() {
    closed = true;
    es?.close();
  }
  return { close };
}
