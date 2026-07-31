import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  clearScreen: false,
  plugins: [react()],
  server: {
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/ws": {
        target: "ws://127.0.0.1:8787",
        ws: true,
      },
    },
  },
})
