import { defineConfig } from "vite";
import { resolve } from "path";
import { builtinModules } from "module";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { DEFAULT_SITENAME, PREFIX } from "./lib";
import { version as VERSION } from "./package.json";

const SITENAME = process.env.SITENAME || DEFAULT_SITENAME;
const BuildVariables: Record<string, string> = { SITENAME, PREFIX, VERSION };

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
          transform: (str: string) =>
            Object.keys(BuildVariables).reduce((v, NAME) => v.replaceAll(`%${NAME}%`, BuildVariables[NAME]), str),
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
