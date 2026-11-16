import test from "node:test";
import assert from "node:assert/strict";
import { createApiClient, ApiError } from "../lib/api-client.ts";
import { SendLedger } from "../lib/send-ledger.ts";
const response = (data: unknown, status = 200) =>
  new Response(
    JSON.stringify({
      ok: status < 400,
      data,
      ...(status >= 400
        ? { error: { code: "forbidden", message: "fixture denied" } }
        : {}),
    }),
    { status },
  );
test("cookie + CSRF client preserves public API envelope and never retries writes", async () => {
  const requests: RequestInit[] = [];
  const api = createApiClient({
    csrf: () => "fixture-csrf",
    fetchImpl: async (_, options) => {
      requests.push(options!);
      return response({ value: 1 });
    },
  });
  assert.deepEqual(await api("POST", "/api/v1/projects", { name: "fixture" }), {
    value: 1,
  });
  assert.equal(requests[0].credentials, "same-origin");
  assert.equal(requests[0].cache, "no-store");
  assert.equal(
    (requests[0].headers as Record<string, string>)["x-csrf-token"],
    "fixture-csrf",
  );
  let count = 0;
  const lost = createApiClient({
    fetchImpl: async () => {
      count++;
      throw Error("lost");
    },
  });
  await assert.rejects(
    () => lost("POST", "/api/v1/projects", {}),
    (e: unknown) => e instanceof ApiError && e.code === "network_uncertain",
  );
  assert.equal(count, 1);
});
test("empty and invalid response are uncertain; HTTP authorization errors retain status", async () => {
  for (const text of ["", "<html>error</html>"]) {
    const api = createApiClient({ fetchImpl: async () => new Response(text) });
    await assert.rejects(
      () => api("POST", "/api/v1/projects", {}),
      (e: unknown) => e instanceof ApiError && e.code === "response_uncertain",
    );
  }
  const api = createApiClient({ fetchImpl: async () => response(null, 403) });
  await assert.rejects(
    () => api("GET", "/api/v1/admin/service"),
    (e: unknown) =>
      e instanceof ApiError && e.status === 403 && e.code === "forbidden",
  );
});
test("request timeout covers reading a streaming body as well as headers", async () => {
  const api = createApiClient({
    timeoutMs: 10,
    fetchImpl: async (_p, options) => {
      const stream = new ReadableStream({
        start(controller) {
          options!.signal!.addEventListener("abort", () =>
            controller.error(Error("aborted")),
          );
        },
      });
      return new Response(stream);
    },
  });
  await assert.rejects(
    () => api("GET", "/api/v1/projects"),
    (e: unknown) => e instanceof ApiError && e.code === "network_uncertain",
  );
});
test("same uncertain draft reuses ID across navigation; changed drafts and late acknowledgements stay isolated", () => {
  const ledger = new SendLedger();
  const a = ledger.attempt("a", "hello", () => "first");
  assert.equal(
    ledger.attempt("a", "hello", () => "not-used"),
    a,
  );
  const b = ledger.attempt("b", "hello", () => "other-project");
  assert.notEqual(a.requestId, b.requestId);
  const newer = ledger.attempt("a", "changed", () => "newer");
  ledger.acknowledge("a", a);
  assert.equal(ledger.attempt("a", "changed"), newer);
  ledger.acknowledge("a", newer);
  assert.equal(
    ledger.attempt("a", "changed", () => "after-ack").requestId,
    "after-ack",
  );
});

test("task and learning identity participate in uncertain-send idempotency", () => {
  const ledger = new SendLedger();
  let n = 0;
  const id = () => String(++n),
    ctx = {
      mode: "learning" as const,
      taskId: "tsk_fixture",
      learning: { action: "lesson", planId: "plan", lessonId: "lesson" },
    };
  const first = ledger.attempt("prj", "继续", id, ctx);
  assert.equal(ledger.pending("prj"), first);
  assert.equal(ledger.attempt("prj", "继续", id, { ...ctx }), first);
  assert.notEqual(
    ledger.attempt("prj", "继续", id, { ...ctx, taskId: null }).requestId,
    first.requestId,
  );
});
