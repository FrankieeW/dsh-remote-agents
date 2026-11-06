import { CHANNEL, RPC_PREFIX, ENDPOINTS } from "./rpc.js";

// Connection's exact Fetch routes are owner-only, admitted by the existing
// authenticated /api carrier (HTTP or IPC). Do not mount these on a raw server.
export function registerRoutes(ctx, handler) {
  for (const endpoint of ENDPOINTS) {
    const method = RPC_PREFIX + endpoint;
    ctx.effect(() =>
      ctx.connection.fetch.register({
        path: `${CHANNEL}/${method}`,
        methods: ["POST"],
        requestBody: "buffered",
        async fetch(request) {
          if (
            request.headers
              .get("content-type")
              ?.split(";")[0]
              .trim()
              .toLowerCase() !== "application/json"
          ) {
            return new Response("Expected JSON", { status: 415 });
          }
          const limit = ["previewHerdr", "importHerdr"].includes(endpoint)
            ? 4 * 1024 * 1024 + 1024
            : 65536 + 1024;
          const reader = request.body?.getReader();
          const chunks = [];
          let size = 0;
          if (reader) {
            try {
              for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > limit) {
                  await reader.cancel();
                  return new Response("Request too large", { status: 413 });
                }
                chunks.push(value);
              }
            } finally {
              reader.releaseLock();
            }
          }
          let message;
          try {
            message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            return new Response("Invalid JSON", { status: 400 });
          }
          if (
            !message ||
            message.type !== "client-request" ||
            typeof message.rpcId !== "string" ||
            !message.rpcId ||
            message.rpcId.length > 256 ||
            message.method !== method
          ) {
            return new Response("Invalid RPC envelope", { status: 400 });
          }
          // The SDK admits ONLY owner Peers to connection.fetch routes.
          const result = await handler(
            endpoint,
            message.payload,
            request.signal,
            { principal: { kind: "owner" } },
          );
          return Response.json({
            type: "server-response",
            rpcId: message.rpcId,
            result,
          });
        },
      }),
    );
  }
}
