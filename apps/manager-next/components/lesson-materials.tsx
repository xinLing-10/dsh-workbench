import { Markdown } from "./markdown";
import type { LearningPlan } from "../lib/contracts";
type Lesson = Pick<
  LearningPlan["lessons"][number],
  "objective" | "materials" | "quiz" | "sourceIds"
>;
export function LessonMaterials({
  lesson: l,
  evidence,
}: {
  lesson: Lesson;
  evidence?: LearningPlan["evidence"];
}) {
  return (
    <>
      <Markdown text={l.objective} />
      {l.materials && <Markdown text={l.materials} />}
      {!!l.sourceIds?.length && (
        <ul className="learning-resources">
          {l.sourceIds.map((id) => {
            const ref = evidence?.sources.find((s) => s.id === id);
            return (
              <li key={id}>
                {ref?.url && /^https:\/\//.test(ref.url) ? (
                  <a href={ref.url} target="_blank" rel="noreferrer noopener">
                    {id} · {ref.title || ref.url}
                  </a>
                ) : (
                  <span>
                    {id} · {ref?.path || "项目资料"}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!!l.quiz?.length && (
        <div className="lesson-quiz">
          <h5>原创测试题 · 先试着作答</h5>
          {l.quiz.map((q, i) => (
            <section key={i}>
              <Markdown text={String(i + 1) + ". " + q.question} />
              <details>
                <summary>查看答案与解析</summary>
                <Markdown
                  text={
                    "**答案**\n" + q.answer + "\n\n**解析**\n" + q.explanation
                  }
                />
              </details>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
