// Keep the transport adapter testable without loading a DSH runtime.
export const CHANNEL = "/remote-agents";
const failure = (code, message) => ({
  ok: false,
  error: { code, message, details: {} },
});
export function createHandler(fleet) {
  const methods = Object.freeze({
    snapshot: () => fleet.snapshot(),
    previewHerdr: (p) => fleet.previewHerdr(p),
    importHerdr: (p) => fleet.importHerdr(p),
    addMachine: (p) => fleet.addMachine(p),
    removeMachine: (p) => fleet.removeMachine(p.machineId),
    probe: (p) => fleet.probe(p.machineId),
    start: (p) => fleet.start(p),
    read: (p) => fleet.read(p.agentId, { lines: p.lines ?? 200 }),
    send: (p) =>
      fleet.send(p.agentId, { text: p.text, enter: p.enter ?? true }),
    interrupt: (p) => fleet.interrupt(p.agentId),
    stop: (p) => fleet.stop(p.agentId),
  });
  return async (endpoint, payload, signal, peer) => {
    if (peer?.principal?.kind !== "owner")
      return failure("forbidden", "仅 DSH 所有者可管理本机和 SSH Agent。");
    if (signal?.aborted) return failure("cancelled", "请求已取消。");
    if (!Object.hasOwn(methods, endpoint))
      return failure("not_found", "未知操作。");
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return failure("invalid_input", "请求参数必须是对象。");
    // Bound payloads independently of the host transport's (larger) body limit.
    try {
      const limit = ["previewHerdr", "importHerdr"].includes(endpoint)
        ? 4 * 1024 * 1024
        : 65536;
      if (new TextEncoder().encode(JSON.stringify(payload)).length > limit)
        return failure("invalid_input", "请求过大。");
      const value = await methods[endpoint](payload);
      return { ok: true, value: value ?? null };
    } catch (error) {
      return failure(
        typeof error?.code === "string" ? error.code : "operation_failed",
        String(error?.message ?? "操作失败").slice(0, 2000),
      );
    }
  };
}
