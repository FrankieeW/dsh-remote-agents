import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Host and import CLI must always resolve the same fleet unless explicitly overridden.
export function resolveStatePath(
  explicit,
  env = process.env,
  home = homedir(),
) {
  const expand = (value) =>
    value === "~"
      ? home
      : value.startsWith("~/")
        ? join(home, value.slice(2))
        : resolve(value);
  if (explicit) return expand(explicit);
  if (env.DSH_REMOTE_AGENTS_STATE?.trim())
    return expand(env.DSH_REMOTE_AGENTS_STATE.trim());
  const dshHome = env.DSH_HOME?.trim()
    ? expand(env.DSH_HOME.trim())
    : join(home, ".dsh");
  return join(dshHome, "remote-agents", "fleet.json");
}
