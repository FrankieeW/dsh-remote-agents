import packageInfo from "../../../package.json" with { type: "json" };

// Keep the transport adapter testable without loading a DSH runtime.
export const CHANNEL = "/api";
export const RPC_PREFIX = "remote-agents/";
export const ENDPOINTS = [
  "snapshot",
  "previewHerdr",
  "importHerdr",
  "addMachine",
  "removeMachine",
  "probe",
  "start",
  "read",
  "send",
  "interrupt",
  "stop",
  "chatList",
  "chatCreate",
  "chatGet",
  "chatSend",
  "chatInterrupt",
  "chatApprove",
  "chatClose",
  "chatOptions",
  "chatConfigure",
  "chatMetadata",
  "chatSearch",
  "chatExport",
  "chatOmpHistory",
  "workspaceRemove",
  "agentUpdatePlan",
  "chatProviders",
  "workspaceCatalog",
  "workspaceBrowse",
  "workspaceAdd",
  "agentUpdate",
  "agentUpdateStatus",
];
const failure = (code, message) => ({
  ok: false,
  error: { code, message, details: {} },
});
export function createHandler(fleet, chat, providerDescriptions = async () => [], hosts, registry) {
  const methods = Object.freeze({
    snapshot: () => fleet.snapshot(),
    agentUpdate: async p => {
      const sessions = await chat.list();
      if (sessions.some(s => s.machineId === p.machineId && s.provider === p.provider && ['running', 'waiting'].includes(s.status))) throw new Error('Stop active sessions for this CLI before updating.');
      return registry.startUpdate(p);
    },
    agentUpdateStatus: p => registry.updateStatus(p.id),
    agentUpdatePlan: p => registry.updatePlan(p),
    workspaceRemove: p => fleet.removeWorkspace(p.workspaceId),
    workspaceCatalog: async () => {
      const { machines, projects } = await fleet.snapshot({ readOnly: true });
      return { pluginVersion: packageInfo.version, machines, workspaces: projects.filter(p => p.machineId !== 'local').map(p => ({ workspaceId: p.id, path: p.cwd, title: p.name, machineId: p.machineId, machineName: machines.find(m => m.id === p.machineId)?.name })) };
    },
    workspaceBrowse: p => hosts.browse(p),
    workspaceAdd: async p => {
      const cwd = await hosts.validateDirectory(p.machineId, p.path);
      return fleet.addWorkspace({ machineId: p.machineId, cwd });
    },
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
    ...(chat ? {
      chatList: async () => ({ sessions: await chat.list(), providers: await providerDescriptions() }),
      chatCreate: async (p) => {
        const provider = (await providerDescriptions(p.machineId || 'local')).find(item => item.id === p.provider);
        if (!provider?.available) throw new Error(provider?.reason || "This backend is unavailable");
        return chat.create(p);
      },
      chatOptions: p => chat.options(p.id, p.refresh),
      chatConfigure: p => chat.configure(p),
      chatMetadata: p => chat.metadata(p),
      chatSearch: p => chat.search(p.query),
      chatExport: p => chat.export(p.id, p.format),
      chatOmpHistory: p => chat.originalOmpTurn(p),
      chatProviders: p => providerDescriptions(p.machineId || 'local', p.refresh === true),
      chatGet: (p) => chat.get(p.id),
      chatSend: (p) => chat.send(p),
      chatInterrupt: (p) => chat.interrupt(p.id),
      chatApprove: (p) => chat.approve(p),
      chatClose: (p) => chat.close(p.id),
    } : {}),
  });
  return async (endpoint, payload, signal, peer) => {
    if (peer?.principal?.kind !== "owner")
      return failure("forbidden", "Only the DSH owner can manage local and SSH agents.");
    if (signal?.aborted) return failure("cancelled", "Request cancelled.");
    if (!Object.hasOwn(methods, endpoint))
      return failure("not_found", "Unknown operation.");
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return failure("invalid_input", "Request payload must be an object.");
    // Bound payloads independently of the host transport's (larger) body limit.
    try {
      const limit = ["previewHerdr", "importHerdr"].includes(endpoint)
        ? 4 * 1024 * 1024
        : 65536;
      if (new TextEncoder().encode(JSON.stringify(payload)).length > limit)
        return failure("invalid_input", "Request too large.");
      const value = await methods[endpoint](payload);
      return { ok: true, value: value ?? null };
    } catch (error) {
      return failure(
        typeof error?.code === "string" ? error.code : "operation_failed",
        String(error?.message ?? "Operation failed").slice(0, 2000),
      );
    }
  };
}
