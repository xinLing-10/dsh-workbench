import { Fragment, type ReactNode } from "react";
function inline(text: string) {
  return text
    .split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g)
    .map((s, i) =>
      s.startsWith("**") && s.endsWith("**") ? (
        <strong key={i}>{s.slice(2, -2)}</strong>
      ) : s.startsWith("`") && s.endsWith("`") ? (
        <code key={i}>{s.slice(1, -1)}</code>
      ) : (
        <Fragment key={i}>{s}</Fragment>
      ),
    );
}
/** Render text through React escaping; raw HTML and model-provided URLs never execute. */
export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n"),
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
      nodes.push(<h3 key={key}>{inline(heading[2])}</h3>);
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
        items.push(<li key={i}>{inline(match[2])}</li>);
        i++;
      }
      nodes.push(
        ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>,
      );
      continue;
    }
    if (line.startsWith("> ")) {
      nodes.push(<blockquote key={key}>{inline(line.slice(2))}</blockquote>);
      i++;
      continue;
    }
    const paragraph = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !special(lines[i]))
      paragraph.push(lines[i++]);
    nodes.push(<p key={key}>{inline(paragraph.join("\n"))}</p>);
  }
  return <div className="formatted-message">{nodes}</div>;
}
