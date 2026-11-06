import { NativeBackend } from "./native/client.js";
import { resolveStatePath } from "./state-path.js";
import { registerRoutes } from "./transport.js";
import { apply as registerImportSkill } from "./skill.js";
export const name = "remote-agents";
export const inject = ["connection"];
export function apply(ctx, config = {}) {
  const backend = new NativeBackend({
    ...config,
    statePath: resolveStatePath(config.statePath),
  });
  registerRoutes(ctx, async (endpoint, payload, signal, peer) => {
    if (peer?.principal?.kind !== "owner")
      return {
        ok: false,
        error: {
          code: "forbidden",
          message: "Only the DSH owner can manage local and SSH agents.",
          details: {},
        },
      };
    if (signal?.aborted)
      return {
        ok: false,
        error: {
          code: "cancelled",
          message: "Request cancelled.",
          details: {},
        },
      };
    try {
      return {
        ok: true,
        value: await backend.request(endpoint, payload, signal),
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: error.code || "operation_failed",
          message: String(error.message || "Rust backend failed").slice(
            0,
            2000,
          ),
          details: {},
        },
      };
    }
  });
  ctx.effect(() => () => backend.close());
  ctx.inject(["skills"], registerImportSkill);
}
