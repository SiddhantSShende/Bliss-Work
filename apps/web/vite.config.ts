import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";

// Web shell. Service base URLs are injected via Vite env (VITE_*) with
// localhost defaults matching docker-compose port mappings.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
  },
  define: {
    __WS_URL__: JSON.stringify(process.env.VITE_WS_URL ?? "ws://localhost:8080/ws"),
  },
});
