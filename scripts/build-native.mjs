import { execFileSync } from "node:child_process";
import { mkdir, copyFile, chmod } from "node:fs/promises";
const mode =
  process.env.DSH_NATIVE_BUILD_MODE === "debug" ? "debug" : "release";
const target = process.env.DSH_NATIVE_TARGET;
const names = {
  "aarch64-apple-darwin": "darwin-arm64",
  "x86_64-apple-darwin": "darwin-x64",
  "aarch64-unknown-linux-musl": "linux-arm64",
  "x86_64-unknown-linux-musl": "linux-x64",
};
if (target && !names[target]) throw Error("Unsupported DSH_NATIVE_TARGET");
execFileSync(
  "cargo",
  [
    "build",
    "--manifest-path",
    "native/Cargo.toml",
    "--locked",
    ...(mode === "release" ? ["--release"] : []),
    ...(target ? ["--target", target] : []),
  ],
  { stdio: "inherit" },
);
const platform = target ? names[target] : `${process.platform}-${process.arch}`;
const directory = `lib/native/${platform}`;
await mkdir(directory, { recursive: true });
await copyFile(
  `native/target/${target ? target + "/" : ""}${mode}/dsh-remote-agents-backend`,
  `${directory}/backend`,
);
await chmod(`${directory}/backend`, 0o755);
console.log(`Built Rust backend for ${platform}`);
