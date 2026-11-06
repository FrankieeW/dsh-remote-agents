import { open, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { NativeBackend } from "./native/client.js";
class NativeFleet {
  constructor(config) {
    this.backend = new NativeBackend(config);
  }
  snapshot() {
    return this.backend.request("snapshot");
  }
  previewHerdr(input) {
    return this.backend.request("previewHerdr", input);
  }
  importHerdr(input) {
    return this.backend.request("importHerdr", input);
  }
  close() {
    return this.backend.close();
  }
}
import { resolveStatePath } from "./state-path.js";

const MAX_FILE = 1024 * 1024;
export const IMPORT_HELP = `DSH Herdr configuration import (offline; never controls Herdr)
Usage:
  dsh-remote-agents-import paths
  dsh-remote-agents-import list [--state <fleet.json>]
  dsh-remote-agents-import preview --machines <endpoints.json|auto> [--state <fleet.json>]
  dsh-remote-agents-import preview --session <session.json> --project-machine <fleet-machine-id> [--state <fleet.json>]
  dsh-remote-agents-import import <same source/state options> --confirm <preview-digest>

You may combine --machines and --session. Project destination must already exist.
Sources are read-only. Import never connects SSH, starts agents, or migrates sessions.
Review the preview and get user confirmation before running import.
`;

export function herdrPaths(
  env = process.env,
  platform = process.platform,
  home = homedir(),
) {
  const state =
    env.XDG_STATE_HOME ||
    (platform === "win32"
      ? env.LOCALAPPDATA || join(home, "AppData", "Local")
      : join(home, ".local", "state"));
  const config =
    env.XDG_CONFIG_HOME ||
    (platform === "win32"
      ? env.APPDATA || join(home, "AppData", "Roaming")
      : join(home, ".config"));
  return {
    machines: join(state, "herdr", "client", "endpoints.json"),
    session: join(config, "herdr", "session.json"),
    namedSessions: join(config, "herdr", "sessions"),
  };
}

export async function readImportSource(path) {
  if (typeof path !== "string" || !path.trim() || /[\x00-\x1f\x7f]/.test(path))
    throw new Error("Invalid source path");
  // NONBLOCK prevents a named pipe from hanging before regular-file validation.
  const file = await open(
    resolve(path),
    constants.O_RDONLY | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_FILE)
      throw new Error(
        "Source must be a regular UTF-8 JSON file, at most 1 MiB",
      );
    const buffer = Buffer.alloc(MAX_FILE + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        used,
        buffer.length - used,
        null,
      );
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > MAX_FILE) throw new Error("Source exceeds 1 MiB");
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, used),
      );
    } catch {
      throw new Error("Source is not valid UTF-8");
    }
  } finally {
    await file.close();
  }
}

export async function runImportCli(
  argv,
  {
    env = process.env,
    stdout = (text) => process.stdout.write(text),
    createFleet = (options) => new NativeFleet(options),
  } = {},
) {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h" || command === undefined) {
    stdout(IMPORT_HELP);
    return;
  }
  if (command === "paths") {
    if (rest.length) throw new Error("paths accepts no options");
    stdout(
      `${JSON.stringify({ ...herdrPaths(env), statePath: resolveStatePath(undefined, env) }, null, 2)}\n`,
    );
    return;
  }
  if (command === "list") {
    if (
      rest.length !== 0 &&
      (rest.length !== 2 || rest[0] !== "--state" || !rest[1])
    )
      throw new Error("list accepts only --state <fleet.json>");
    const statePath = resolveStatePath(rest[1], env);
    const fleet = createFleet({ statePath });
    let machines, projects;
    try {
      ({ machines, projects } = await fleet.snapshot({ readOnly: true }));
    } finally {
      await fleet.close?.();
    }
    stdout(`${JSON.stringify({ statePath, machines, projects }, null, 2)}\n`);
    return;
  }
  if (!["preview", "import"].includes(command))
    throw new Error("Unknown command; use --help");
  const accepted = new Set([
    "--machines",
    "--session",
    "--project-machine",
    "--state",
    "--confirm",
  ]);
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i],
      value = rest[i + 1];
    if (
      !accepted.has(key) ||
      Object.hasOwn(options, key) ||
      typeof value !== "string" ||
      !value ||
      value.startsWith("--")
    )
      throw new Error("Unknown, repeated, or incomplete option");
    options[key] = value;
  }
  if (!options["--machines"] && !options["--session"])
    throw new Error("Provide --machines and/or --session");
  if (options["--session"] && !options["--project-machine"])
    throw new Error(
      "Session directory import requires explicit --project-machine",
    );
  if (
    command === "import" &&
    !/^[a-f0-9]{64}$/.test(options["--confirm"] || "")
  )
    throw new Error(
      "Import requires --confirm with the reviewed preview digest",
    );
  if (command === "preview" && options["--confirm"])
    throw new Error("preview does not accept --confirm");
  const input = {};
  if (options["--machines"])
    input.machinesText = await readImportSource(
      options["--machines"] === "auto"
        ? herdrPaths(env).machines
        : options["--machines"],
    );
  if (options["--session"])
    input.sessionText = await readImportSource(options["--session"]);
  if (options["--project-machine"])
    input.projectMachineId = options["--project-machine"];
  const statePath = resolveStatePath(options["--state"], env);
  const fleet = createFleet({ statePath });
  let result;
  try {
    result =
      command === "preview"
        ? await fleet.previewHerdr(input)
        : await fleet.importHerdr({
            ...input,
            confirmation: options["--confirm"],
          });
  } finally {
    await fleet.close?.();
  }
  stdout(`${JSON.stringify({ statePath, ...result }, null, 2)}\n`);
}
