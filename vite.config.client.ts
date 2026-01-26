import { defineConfig } from "vite";
import { resolve } from "path";
import { builtinModules } from "module";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { PREFIX } from "./lib";
import { version as VERSION } from "./package.json";

export default defineConfig({
  plugins: [
    viteStaticCopy({
      targets: [
        {
          src: "robots.txt",
          dest: ".",
        },
        {
          src: "index.html",
          dest: ".",
          rename: (name, ext) => PREFIX + name + (ext ? "." + ext : ""),
          transform: (contents: string) => contents.replaceAll("%PREFIX%", PREFIX).replaceAll("%VERSION%", VERSION),
        },
      ],
    }),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    minify: true,
    rollupOptions: {
      input: resolve(__dirname, "inject.ts"),
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
      output: {
        entryFileNames: PREFIX + "inject.js",
        format: "iife",
        name: PREFIX + "inject",
        inlineDynamicImports: true, // Forces everything into one file!
      },
    },
  },
});
