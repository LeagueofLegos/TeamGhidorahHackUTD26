import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { demoApi } from "./dev-api.js";

export default defineConfig({
  plugins: [react(), demoApi()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    fs: {
      allow: [".."],
      deny: [
        "**/.tokens/**",
        "**/.runtime*/**",
        "**/.git/**",
        "**/.env",
        "**/.env.*",
        "**/*.{crt,pem}",
      ],
    },
  },
});
