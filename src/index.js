import { dirname, join } from "node:path";
import { ChatManager } from "./chat/manager.js";
import { createProviderRegistry } from "./chat/providers.js";
import { resolveStatePath } from "./state-path.js";
import { FleetManager } from "./core/index.js";
import { registerFleetRoutes } from "./transport.js";
import { apply as registerImportSkill } from "./skill.js";

export const name = "remote-agents";
export const inject = ["connection"];

export function apply(ctx, config = {}) {
  const statePath = resolveStatePath(config.statePath);
  const fleet = new FleetManager({ statePath });
  const registry = createProviderRegistry({
    claudeExecutable: config.claudeExecutable,
    ompExecutable: config.ompExecutable,
    sessionRoot: join(dirname(statePath), "omp-sessions"),
  });
  const chat = new ChatManager({
    statePath: join(dirname(statePath), "conversations.json"),
    providers: registry.providers,
  });
  registerFleetRoutes(ctx, fleet, chat, registry.descriptions);
  // External structured runtimes belong to this Host instance, unlike tmux.
  // Teardown denies live approvals and interrupts children; it never approves them.
  ctx.effect(() => () => chat.dispose());
  // Register with the existing skill service without a second client-plugin entry.
  ctx.inject(["skills"], registerImportSkill);
  // Do not kill persistent tmux sessions on HMR, plugin unload, or host restart.
}
