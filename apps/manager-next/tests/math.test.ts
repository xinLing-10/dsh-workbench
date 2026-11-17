import test from "node:test";
import assert from "node:assert/strict";
import { splitMath, renderMath } from "../lib/math.ts";
test("explicit delimiters, Greek and multiline math", () => {
  const p = splitMath(
    "中文 $x^2$ English \\(\\alpha+\\beta\\)。\n$$\\begin{bmatrix}1&0\\\\0&1\\end{bmatrix}$$\n\\[\\int_0^1 x\\,dx=\\frac{1}{2}\\]",
  );
  assert.equal(p.filter((x) => x.kind === "math").length, 4);
  for (const x of p.filter((x) => x.kind === "math"))
    assert.ok(renderMath(x.text, x.display)?.includes("katex"));
  assert.ok(renderMath("α+β=θ", false));
});
test("money URLs links escaped dollars and code stay literal", () => {
  const text =
    "price $5 and $10. \\$x\\$ ` $x$ `\n```tex\n$$x$$\n```\n[doc](https://example.test/$x$) https://example.test/$x$";
  assert.equal(splitMath(text).filter((x) => x.kind === "math").length, 0);
  assert.equal(
    splitMath("价格 $5 and $10，代码 \x60$x$\x60 保留原样。").filter(
      (x) => x.kind === "math",
    ).length,
    0,
  );
});
test("incomplete stream and unsafe/invalid formula fallback", () => {
  for (const t of ["$$\\frac{", "中文 \\(x^", "cost $5"])
    assert.equal(
      splitMath(t)
        .map((p) => p.raw)
        .join(""),
      t,
    );
  for (const t of [
    "\\frac{1}{",
    "\\href{javascript:alert(1)}{x}",
    "\\includegraphics{https://example.test/a.png}",
  ])
    assert.equal(renderMath(t, false), null);
  assert.equal(renderMath("x".repeat(6001), false), null);
});

test("plain Windows and Unix paths retain literal delimiters", () => {
  const text = "C:\\\\(backup\\\\)\\\\file.txt /tmp/$x$/a.md";
  assert.equal(
    splitMath(text)
      .map((p) => p.raw)
      .join(""),
    text,
  );
  assert.equal(splitMath(text).filter((p) => p.kind === "math").length, 0);
});
