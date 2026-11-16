"use client";
import { useEffect, useRef, useState } from "react";
export type ProjectStreamEvent = {
  id: number;
  operationId: string;
  type: string;
  payload: { text?: string };
};
const types = [
  "message_created",
  "manager_message",
  "message_completed",
  "interaction_created",
  "interaction_answered",
  "interaction_cancelled",
  "artifact_version",
  "task_status",
  "recovery_check",
];
/** Native cursor replay; never initiates model work. Preview snapshots bypass full refresh. */
export function useProjectEvents(
  projectId: string | null,
  onRefresh: () => Promise<void>,
  onError: (m: string) => void,
  onStream?: (event: ProjectStreamEvent) => void,
) {
  const refresh = useRef(onRefresh),
    error = useRef(onError),
    stream = useRef(onStream);
  refresh.current = onRefresh;
  error.current = onError;
  stream.current = onStream;
  const [status, setStatus] = useState("正在连接…");
  useEffect(() => {
    if (!projectId) return;
    let disposed = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const source = new EventSource(
      "/api/v1/projects/" + encodeURIComponent(projectId) + "/events",
    );
    const changed = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (!disposed)
          void refresh.current().catch(() => {
            if (!disposed)
              error.current(
                "最新进展暂未刷新，实时连接会继续恢复；请勿重复发送。",
              );
          });
      }, 200);
    };
    source.onopen = () => {
      setStatus("实时连接");
      changed();
    };
    source.onerror = () => setStatus("正在重连…");
    const preview = (raw: Event) => {
      try {
        const e = JSON.parse((raw as MessageEvent).data);
        if (
          Number.isSafeInteger(e.id) &&
          typeof e.operationId === "string" &&
          typeof e.payload?.text === "string"
        )
          stream.current?.(e);
      } catch {
        changed();
      }
    };
    source.addEventListener("message_stream", preview);
    for (const type of types)
      source.addEventListener(type, (e) => {
        if (type === "message_completed") preview(e);
        changed();
      });
    return () => {
      disposed = true;
      clearTimeout(timer);
      source.close();
    };
  }, [projectId]);
  return status;
}
