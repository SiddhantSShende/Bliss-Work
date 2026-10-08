// The harness lives in the repo; run.sh copies it into a SCRATCH copy of the workspace
// (see node-modules-gutted: the real node_modules cannot run Vite here) and serves it.
import { defineConfig } from "vite";
export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  esbuild: { jsx: "automatic" },
  server: { host: "localhost", port: Number(process.env.HARNESS_PORT ?? 5197), strictPort: true, fs: { allow: [".."] } },
  logLevel: "warn",
});
