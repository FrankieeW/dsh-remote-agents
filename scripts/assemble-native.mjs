// Assemble artifacts produced by native-binaries.yml before npm pack.
import { cp, access, chmod, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
const targets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
const source = resolve(process.argv[2] || "native-artifacts");
for (const target of targets) {
  const input = join(source, target, "backend");
  await access(input);
  const output = join("lib", "native", target);
  await mkdir(output, { recursive: true });
  await cp(input, join(output, "backend"));
  await chmod(join(output, "backend"), 0o755);
}
console.log("Assembled all four native platforms; npm pack will retain them.");
