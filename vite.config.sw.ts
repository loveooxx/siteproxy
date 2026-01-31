import { resolve } from "node:path";
import { builtinModules } from "node:module";
import { defineConfig } from "vite";
import { PREFIX } from "./lib";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    minify: true,
    rollupOptions: {
      input: resolve(__dirname, "sw.ts"),
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
      output: {
        entryFileNames: PREFIX + "sw.js",
        format: "es",
        inlineDynamicImports: true, // Forces everything into one file!
      },
    },
  },
});
