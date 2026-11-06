const readline = require("node:readline");
const output = (v) => process.stdout.write(JSON.stringify(v) + "\n");
let session;
const sdk = (message) => output({ type: "sdk_message", message });
const finish = (text) => {
  sdk({
    type: "stream_event",
    event: { type: "message_start", message: { id: "m1" } },
  });
  sdk({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
  });
  sdk({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
  });
  sdk({
    type: "assistant",
    uuid: "one",
    message: { id: "m1", content: [{ type: "text", text }] },
  });
  sdk({
    type: "assistant",
    uuid: "one",
    message: { id: "m1", content: [{ type: "text", text }] },
  });
  sdk({
    type: "result",
    subtype: "success",
    session_id: "owned-claude",
    result: text,
  });
  output({ type: "bridge_end" });
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const f = JSON.parse(line);
  if (f.type === "start") {
    session = f.session;
    sdk({
      type: "system",
      subtype: "init",
      session_id: "owned-claude",
      model: "fixture",
      permissionMode: "default",
    });
    if (f.prompt === "WAIT") return;
    if (f.prompt === "APPROVAL" || f.prompt === "RICH") {
      output({
        type: "bridge_approval",
        id: "approval-1",
        toolName: f.prompt === "RICH" ? "AskUserQuestion" : "Write",
        input: { path: "test.txt" },
        requiresUserInteraction: f.prompt === "RICH",
      });
      return;
    }
    if (f.prompt === "ERROR") {
      sdk({
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        session_id: "owned-claude",
        result: "Fixture quota error",
      });
      output({ type: "bridge_end" });
      return;
    }
    finish("CLAUDE_NATIVE_OK");
  }
  if (f.type === "approval") finish(f.allow ? "APPROVED_ONCE" : "DENIED");
  if (f.type === "abort") process.exit(0);
});
