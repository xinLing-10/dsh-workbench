export class ApiError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status = 0) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}
/** No automatic write retries: a missing HTTP receipt can still mean accepted work. */
export function createApiClient({
  csrf = () => "",
  fetchImpl = fetch,
  timeoutMs = 30000,
}: { csrf?: () => string; fetchImpl?: typeof fetch; timeoutMs?: number } = {}) {
  return async function api<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!path.startsWith("/api/v1/"))
      throw new ApiError("无效的服务地址。", "validation");
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response, text: string;
    try {
      response = await fetchImpl(path, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        signal: signal
          ? AbortSignal.any([signal, controller.signal])
          : controller.signal,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(method === "GET" ? {} : { "x-csrf-token": csrf() }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      text = await response.text();
    } catch {
      throw new ApiError(
        method === "GET"
          ? "连接中断，未能刷新最新状态，请重试打开项目。"
          : "尚未收到服务器回执，操作可能已送达。请先核对记录，不要重复提交。",
        "network_uncertain",
      );
    } finally {
      clearTimeout(timer);
    }
    let payload: {
      ok?: boolean;
      data: T;
      error?: { message?: string; code?: string };
    };
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ApiError(
        "服务器返回异常，请核对记录后再继续。",
        "response_uncertain",
        response.status,
      );
    }
    if (!response.ok || !payload.ok)
      throw new ApiError(
        payload.error?.message || `请求失败（${response.status}）`,
        payload.error?.code || "unavailable",
        response.status,
      );
    return payload.data;
  };
}
export type Api = ReturnType<typeof createApiClient>;
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "操作未完成，请核对记录。";
