import { resolve } from "node:path";
import { builtinModules } from "node:module";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: ".",
    emptyOutDir: false,
    minify: true,
    rollupOptions: {
      input: resolve(__dirname, "index.ts"),
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
      output: {
        entryFileNames: "index.js",
        format: "es",
        inlineDynamicImports: true, // Forces everything into one file!
      },
    },
  },
});
