import { defineConfig } from "tsup"

export default defineConfig({
    entry: ["index.ts"],
    format: ["esm"],
    dts: false,
    clean: true,
    sourcemap: true,
    noExternal: ["jsonc-parser", "@opencode-ai/plugin"], // Bundle these — see fork PLAN.md §5.6, §5.7
})
