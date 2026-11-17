import { Fragment, type ReactNode } from "react";
import { splitMath, type MathPart } from "../lib/math";
import { MathFormula } from "./math-formula";
function inline(text: string, formulae: MathPart[] = []) {
  return text
    .split(/(\uE000\d+\uE001|\*\*[^*\n]+\*\*|`[^`\n]+`)/g)
    .map((s, i) =>
      /^\uE000\d+\uE001$/.test(s) ? (
        <MathFormula
          key={i}
          source={formulae[Number(s.slice(1, -1))].text}
          raw={formulae[Number(s.slice(1, -1))].raw}
          display={formulae[Number(s.slice(1, -1))].display}
        />
      ) : s.startsWith("**") && s.endsWith("**") ? (
        <strong key={i}>{inline(s.slice(2, -2), formulae)}</strong>
      ) : s.startsWith("`") && s.endsWith("`") ? (
        <code key={i}>{s.slice(1, -1)}</code>
      ) : (
        <Fragment key={i}>{s}</Fragment>
      ),
    );
}
/** Render text through React escaping; raw HTML and model-provided URLs never execute. */
export function Markdown({ text }: { text: string }) {
  const formulae: MathPart[] = [];
  const prepared = splitMath(text.replace(/\uE000/g, "\uFFFD"))
    .map((part) => {
      if (part.kind === "text") return part.text;
      const index = formulae.push(part) - 1;
      return "\uE000" + index + "\uE001";
    })
    .join("");
  const lines = prepared.replace(/\r\n/g, "\n").split("\n"),
    nodes: ReactNode[] = [];
  let i = 0;
  const special = (s: string) =>
    /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|```|>\s)/.test(s);
  while (i < lines.length) {
    const line = lines[i],
      key = i;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```"))
        code.push(lines[i++]);
      i++;
      nodes.push(
        <pre key={key}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      nodes.push(<h3 key={key}>{inline(heading[2], formulae)}</h3>);
      i++;
      continue;
    }
    const item = line.match(/^([-*+]|\d+[.)])\s+(.+)$/);
    if (item) {
      const ordered = /^\d/.test(item[1]),
        items = [];
      while (i < lines.length) {
        const match = lines[i].match(/^([-*+]|\d+[.)])\s+(.+)$/);
        if (!match || /^\d/.test(match[1]) !== ordered) break;
        items.push(<li key={i}>{inline(match[2], formulae)}</li>);
        i++;
      }
      nodes.push(
        ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>,
      );
      continue;
    }
    if (line.startsWith("> ")) {
      nodes.push(
        <blockquote key={key}>{inline(line.slice(2), formulae)}</blockquote>,
      );
      i++;
      continue;
    }
    const paragraph = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !special(lines[i]))
      paragraph.push(lines[i++]);
    nodes.push(<p key={key}>{inline(paragraph.join("\n"), formulae)}</p>);
  }
  return <div className="formatted-message">{nodes}</div>;
}
