import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

/** Minimal build for the drop fixture — no Tailwind, no env gate. The check
 *  reads the DOM and a JS array, so styling would only slow the build down. */
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  define: { __WS_URL__: JSON.stringify("ws://127.0.0.1:1/ws") },
  build: { outDir: "dist", emptyOutDir: true },
});
