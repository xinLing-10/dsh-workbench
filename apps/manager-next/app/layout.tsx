import type { Metadata } from "next";
import "katex/dist/katex.min.css";
import "./globals.css";
export const metadata: Metadata = {
  title: "项目管家",
  description: "说清想法，一起完成，学懂原理。",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
