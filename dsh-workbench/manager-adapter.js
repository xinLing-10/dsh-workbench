/** DSH 0.2.1 Host SessionController boundary. No browser or model credentials here. */
export function createSessionAdapter(controller) {
  const signal = () => AbortSignal.timeout(15000);
  return {
    async create({ root, preset, id, title }) {
      const created = await controller.create({ cwd: root, agentPreset: preset, sessionId: id });
      await controller.rename({ sessionId: created.sessionId, title });
      return created.sessionId;
    },
    async submit({ sessionId, requestId, prompt }) {
      const result = await controller.prompt({ sessionId, requestId, mode: 'queue', content: [{ type: 'text', text: prompt }] }, signal());
      if (!result?.accepted) throw new Error('DSH 未确认接收任务，请检查会话。');
    },
    async read(sessionId) {
      const projection = await controller.projections({ sessionId }, signal());
      if (!projection || projection.kind !== 'sequenced') throw new Error('会话状态暂不可用，请在详细工作区检查。');
      const page = await controller.page({ address: { kind: 'session', sessionId }, throughSeq: projection.asOfSeq, maxMessages: 100 }, signal());
      const events = page.records.filter((r) => r.type === 'event').map((r) => r.event);
      const end = events.filter((e) => e.type === 'turn/end').at(-1);
      const start = events.filter((e) => e.type === 'turn/start').at(-1);
      const last = events.filter((e) => e.type === 'assistant/message' && !e.data.interrupted).at(-1);
      const text = (last?.data.message?.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
      const terminal = !!end && (!start || end.seq > start.seq) && projection.values.turn?.openTurnStartSeq == null;
      return { terminal, reason: terminal ? end.data.reason : '', text, events,
        running: projection.values.turn?.openTurnStartSeq != null };
    },
    async cancel(sessionId) {
      const result = await controller.cancel({ sessionId });
      if (!result?.accepted) throw new Error('DSH 未确认停止请求。');
    },
  };
}
