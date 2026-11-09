import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Standalone development and build (index.html → dev/main.ts, with a stand-in
// host). The MnemoNexus add-on is built by the add-on kit: npm run addon:pack.
// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  // dist/ also holds the .mnxpack, so the standalone page gets its own folder.
  build: { outDir: "dist/standalone" },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
