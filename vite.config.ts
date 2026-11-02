import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { jsxSource } from "./scripts/jsx-source";
export default defineConfig({
  plugins: [jsxSource(), react()],
  base: "./",
  server: { host: "127.0.0.1", port: 4173, strictPort: true },
});
