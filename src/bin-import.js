#!/usr/bin/env node
import { runImportCli } from "./import-cli.js";
try {
  await runImportCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ ok: false, error: { code: error?.code || "IMPORT_FAILED", message: String(error?.message || "Import failed").slice(0, 2000) } })}\n`,
  );
  process.exitCode = 1;
}
