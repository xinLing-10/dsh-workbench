"use client";
import { useState } from "react";
import { renderMath } from "../lib/math";
export function MathFormula({
  source,
  raw,
  display,
}: {
  source: string;
  raw: string;
  display: boolean;
}) {
  const [copyState, setCopyState] = useState("复制源码");
  const html = renderMath(source, display);
  return (
    <span
      className={
        display ? "math-formula math-block" : "math-formula math-inline"
      }
    >
      {html ? (
        <span dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <code className="math-fallback" title="公式暂时无法排版，已保留原文">
          {raw}
        </code>
      )}
      <button
        type="button"
        className="math-copy"
        aria-label="复制公式源码"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(source);
            setCopyState("已复制");
          } catch {
            setCopyState("复制不可用");
          }
        }}
      >
        {copyState}
      </button>
    </span>
  );
}
