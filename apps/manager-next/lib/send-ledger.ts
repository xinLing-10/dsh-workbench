export type SendContext = {
  mode: "work" | "learning";
  taskId: string | null;
  learning?: { action: string; planId?: string; lessonId?: string };
};
export type SendAttempt = {
  text: string;
  requestId: string;
} & Partial<SendContext>;
/** Kept in the shared workspace provider, so navigation does not create a new paid request. */
export class SendLedger {
  private attempts = new Map<string, SendAttempt>();
  attempt(
    projectId: string,
    text: string,
    newId: () => string = () => crypto.randomUUID(),
    context?: SendContext,
  ) {
    const old = this.attempts.get(projectId);
    if (
      old?.text === text &&
      JSON.stringify({
        mode: old.mode,
        taskId: old.taskId,
        learning: old.learning,
      }) === JSON.stringify(context || {})
    )
      return old;
    const next = { text, requestId: newId(), ...context };
    this.attempts.set(projectId, next);
    return next;
  }
  pending(projectId: string) {
    return this.attempts.get(projectId);
  }
  acknowledge(projectId: string, attempt: SendAttempt) {
    if (this.attempts.get(projectId) === attempt)
      this.attempts.delete(projectId);
  }
}
export const operationLabels: Record<string, string> = {
  accepted: "已接收",
  queued: "排队中",
  running: "执行中",
  waiting: "等待回答",
  uncertain: "待核对",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};
export function operationNote(state?: string) {
  return (
    (
      {
        queued: "消息已保存，正在等待管家处理。",
        running: "管家正在处理，你可以随时查看进展。",
        waiting: "请回答下方问题，或决定是否允许本次操作。",
        uncertain: "这条任务结果待核对，请联系管理员，不要重复发送。",
        completed: "本轮处理已结束，成果仍需你阅读和确认。",
        failed: "本轮执行失败，请先核对处理记录再决定下一步。",
        cancelled: "已确认停止；已经生成的成果会保留。",
      } as Record<string, string>
    )[state || ""] || "说说你的想法，我们一起完成。"
  );
}
