import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
await mkdir("lib", { recursive: true });
await build({
  entryPoints: ["src/index.js"],
  outfile: "lib/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  external: ["@anthropic-ai/claude-agent-sdk"],
});
await build({
  entryPoints: ["src/bin-import.js"],
  outfile: "lib/import-cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
});
await build({
  entryPoints: ["src/skill.js"],
  outfile: "lib/skill.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
});
const browser = await build({
  entryPoints: ["src/client-entry.jsx"],
  bundle: true,
  write: false,
  platform: "browser",
  format: "cjs",
  target: "es2022",
  jsx: "automatic",
  loader: { ".css": "text" },
  // Supplied by the DSH shell's shared module table; never bundled.
  external: ["react", "react/jsx-runtime", "react-dom", "react-dom/client", "@deepseek-ai/dsh-client-ui-primitives"],
  minify: false,
});
const body = browser.outputFiles[0].text;
await writeFile(
  "lib/client.js",
  `window.__ModuleLoader__.load({id:'dsh-remote-agents',factory:(require)=>{\nvar module={exports:{}};var exports=module.exports;\n${body}\nreturn module.exports;\n}});\n`,
);
console.log("Built DSH host ESM and lazy client factory.");
