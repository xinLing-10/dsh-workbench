"use client";
import { useEffect, useRef, useState, type RefObject } from "react";
export function ResizableInput({
  value,
  onChange,
  inputRef,
}: {
  value: string;
  onChange: (text: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const [height, setHeight] = useState(110),
    [maximum, setMaximum] = useState(360);
  const drag = useRef<{ y: number; height: number } | null>(null);
  useEffect(() => {
    const resize = () => {
      const max = Math.max(
        80,
        Math.min(480, Math.floor(window.innerHeight * 0.45)),
      );
      setMaximum(max);
      setHeight((h) => Math.min(h, max));
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const change = (h: number) => setHeight(Math.max(80, Math.min(maximum, h)));
  return (
    <div className="resizable-input">
      <div
        className="input-resize-handle"
        role="separator"
        tabIndex={0}
        aria-label="调整输入框高度：向上拖动或按向上箭头扩大"
        aria-orientation="horizontal"
        aria-valuemin={80}
        aria-valuemax={maximum}
        aria-valuenow={height}
        onKeyDown={(e) => {
          if (["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
            e.preventDefault();
            change(
              e.key === "Home"
                ? 80
                : e.key === "End"
                  ? maximum
                  : height + (e.key === "ArrowUp" ? 24 : -24),
            );
          }
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          drag.current = { y: e.clientY, height };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (drag.current)
            change(drag.current.height + drag.current.y - e.clientY);
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
      >
        <span aria-hidden="true">━━━━</span>
        <small>上下拖动调整输入区</small>
      </div>
      <label className="sr-only" htmlFor="message-text">
        给管家发消息
      </label>
      <textarea
        id="message-text"
        ref={inputRef}
        style={{ height }}
        maxLength={30000}
        placeholder="说说你的想法，或者问一个问题…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
