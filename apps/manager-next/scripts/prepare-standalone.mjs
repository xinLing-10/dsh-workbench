import { cp, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url)),
  out = join(root, ".next/standalone");
await stat(join(out, "server.js"));
await rm(join(out, ".next/static"), { recursive: true, force: true });
await cp(join(root, ".next/static"), join(out, ".next/static"), {
  recursive: true,
});
try {
  await stat(join(root, "public"));
  await cp(join(root, "public"), join(out, "public"), { recursive: true });
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
console.log("Prepared standalone server and static assets.");
