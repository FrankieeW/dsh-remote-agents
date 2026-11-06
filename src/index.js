import { resolveStatePath } from "./state-path.js";
import { FleetManager } from "./core/index.js";
import { CHANNEL, createHandler } from "./rpc.js";
import { apply as registerImportSkill } from "./skill.js";

export const name = "remote-agents";
export const inject = ["connection", "webServer"];

export function apply(ctx, config = {}) {
  const statePath = resolveStatePath(config.statePath);
  const fleet = new FleetManager({ statePath });
  ctx.connection.rpc.handle(CHANNEL, createHandler(fleet));
  // Register with the existing skill service without a second client-plugin entry.
  ctx.inject(["skills"], registerImportSkill);
  // Do not kill persistent tmux sessions on HMR, plugin unload, or host restart.
}
