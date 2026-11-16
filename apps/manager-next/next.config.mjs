const backend = new URL(
  process.env.MANAGER_API_ORIGIN || "http://127.0.0.1:8106",
);
if (
  !["http:", "https:"].includes(backend.protocol) ||
  backend.username ||
  backend.password ||
  backend.pathname !== "/" ||
  backend.search ||
  backend.hash
)
  throw Error("MANAGER_API_ORIGIN must be a fixed private backend origin");
export default {
  output: "standalone",
  poweredByHeader: false,
  compress: false,
  images: { unoptimized: true },
  async rewrites() {
    return [
      {
        source: "/api/v1/:path*",
        destination: `${backend.origin}/api/v1/:path*`,
      },
      { source: "/help", destination: `${backend.origin}/help` },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
        ],
      },
    ];
  },
};
