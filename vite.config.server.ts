import { defineConfig } from "vite";
import { resolve } from "path";
import { builtinModules } from "module";

export default defineConfig({
  build: {
    outDir: ".",
    emptyOutDir: false,
    minify: false,
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
