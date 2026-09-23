import { defineConfig } from "tsup";
import pkg from "./package.json";

export default defineConfig([
  // Plugin entry point (loaded by OpenCode's plugin system)
  {
    entry: { plugin: "src/plugin.ts" },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    external: ["@opencode-ai/plugin", "@opencode-ai/sdk", "bun:sqlite"],
  },
  // CLI entry point (standalone Bun script). Dependencies are bundled so the
  // staged daemon runs without node_modules, which package managers hoist
  // out of the package root.
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    sourcemap: true,
    external: ["bun:sqlite"],
    noExternal: Object.keys(pkg.dependencies),
    banner: { js: "#!/usr/bin/env bun" },
  },
]);
