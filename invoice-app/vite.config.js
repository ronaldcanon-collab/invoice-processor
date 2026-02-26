import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    // In dev, proxy /api/* to the Vercel dev server (run `vercel dev` instead of `npm run dev`)
    // Or use: ANTHROPIC_API_KEY=sk-... vercel dev
  },
});
