import katex from "katex";
export type MathPart = {
  kind: "text" | "math";
  text: string;
  raw: string;
  display: boolean;
};
const escaped = (text: string, i: number) => {
  let n = 0;
  while (i > 0 && text[--i] === "\\") n++;
  return n % 2 === 1;
};
/** Only explicit math delimiters; code, links and plain URLs remain literal. */
export function splitMath(text: string): MathPart[] {
  const parts: MathPart[] = [];
  let literal = "",
    i = 0,
    count = 0;
  const flush = () => {
    if (literal)
      parts.push({ kind: "text", text: literal, raw: literal, display: false });
    literal = "";
  };
  while (i < text.length) {
    const rest = text.slice(i);
    const fence = /^(?:\x60{3,}|~{3,})/.exec(rest);
    if (fence && (i === 0 || text[i - 1] === "\n")) {
      const end = text.indexOf("\n" + fence[0], i + fence[0].length);
      const stop = end < 0 ? text.length : end + 1 + fence[0].length;
      literal += text.slice(i, stop);
      i = stop;
      continue;
    }
    if (text[i] === "\x60") {
      const ticks = /^\x60+/.exec(rest)![0];
      const end = text.indexOf(ticks, i + ticks.length);
      const stop = end < 0 ? text.indexOf("\n", i) : end + ticks.length;
      const at = stop < 0 ? text.length : stop;
      literal += text.slice(i, at);
      i = at;
      continue;
    }
    const protectedText =
      /^(?:!?\[[^\]\n]*\]\([^)\n]*\)|https?:\/\/[^\s<>]+)/.exec(rest);
    if (protectedText) {
      literal += protectedText[0];
      i += protectedText[0].length;
      continue;
    }
    const filePath = /^(?:[A-Za-z]:[\\/][^\s]+|(?:\.{1,2}\/|\/)[^\s]+)/.exec(
      rest,
    );
    if (filePath && (i === 0 || /[\s"'(]/.test(text[i - 1]))) {
      literal += filePath[0];
      i += filePath[0].length;
      continue;
    }
    let open = "",
      close = "",
      display = false;
    if (!escaped(text, i)) {
      if (rest.startsWith("$$")) {
        open = close = "$$";
        display = true;
      } else if (rest.startsWith("\\[")) {
        open = "\\[";
        close = "\\]";
        display = true;
      } else if (rest.startsWith("\\(")) {
        open = "\\(";
        close = "\\)";
      } else if (rest.startsWith("$")) open = close = "$";
    }
    if (open && count < 64) {
      let end = text.indexOf(close, i + open.length);
      while (end >= 0 && escaped(text, end))
        end = text.indexOf(close, end + close.length);
      if (end >= 0) {
        const value = text.slice(i + open.length, end),
          raw = text.slice(i, end + close.length);
        const valid =
          !!value.trim() &&
          (display || (!value.includes("\n") && value === value.trim())) &&
          !(
            open === "$" &&
            (/^\d[\d.,]*\s+[A-Za-z]/.test(value) ||
              value.includes("\x60") ||
              (/[\u4e00-\u9fff]/.test(value) && !value.includes("\\text")))
          );
        if (valid) {
          flush();
          parts.push({ kind: "math", text: value, raw, display });
          count++;
          i = end + close.length;
          continue;
        }
      }
    }
    literal += text[i++];
  }
  flush();
  return parts;
}
export function renderMath(source: string, display: boolean): string | null {
  if (
    source.length > 6000 ||
    /\\(?:href|url|includegraphics|html[A-Za-z]*|class|style)\b/.test(source)
  )
    return null;
  try {
    return katex.renderToString(source, {
      displayMode: display,
      output: "htmlAndMathml",
      throwOnError: true,
      trust: false,
      strict: "error",
      maxExpand: 200,
      maxSize: 10,
      macros: {},
    });
  } catch {
    return null;
  }
}
