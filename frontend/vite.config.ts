import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// In dev, proxy API calls to the deployed stack (CloudFront routes /api + /public to API Gateway).
// Before DNS exists, point it at the CloudFront domain: VITE_API_TARGET=https://xxxx.cloudfront.net npm run dev
const API_TARGET = process.env.VITE_API_TARGET || "https://bozobet.claytondavis.dev";
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true },
      "/public": { target: API_TARGET, changeOrigin: true },
    },
  },
});
