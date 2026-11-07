if (process.argv.includes("--version")) {
  console.log("18.17.0");
  process.exit(0);
}
if (process.argv[2] === "models") {
  console.log(
    JSON.stringify({
      models: [
        {
          id: "fixture",
          provider: "fixture",
          name: "Fixture",
          selector: "fixture/fixture",
          reasoning: true,
        },
      ],
    }),
  );
  process.exit(0);
}
if (process.argv[2] === "config") {
  const key = process.argv[4];
  console.log(
    JSON.stringify({
      value:
        key === "modelRoles"
          ? { default: "fixture/fixture" }
          : key === "defaultThinkingLevel"
            ? "low"
            : "always-ask",
    }),
  );
  process.exit(0);
}
const readline = require("node:readline");
const cwd = process.argv[process.argv.indexOf("--cwd") + 1];
let promptId;
const output = (v) => process.stdout.write(JSON.stringify(v) + "\n");
const complete = (text) => {
  output({
    type: "message_start",
    messageId: "reply",
    message: {
      role: "assistant",
      content: [{ type: "text", text: text.slice(0, 3) }],
    },
  });
  output({
    type: "message_update",
    messageId: "reply",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
  output({
    type: "message_end",
    messageId: "reply",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
  output({ type: "prompt_result", id: promptId, status: "completed" });
  output({ type: "session_settled" });
};
output({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
});
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const f = JSON.parse(line);
  const reply = (data) =>
    output({
      type: "response",
      id: f.id,
      command: f.type,
      success: true,
      data,
    });
  if (f.type === "negotiate_protocol") reply({ protocolVersion: 2 });
  if (f.type === "get_state")
    reply({
      sessionId: "owned-omp",
      cwd,
      model: { id: "fixture", provider: "fixture" },
      thinkingLevel: "low",
    });
  if (f.type === "prompt") {
    promptId = f.id;
    reply({});
    if (f.message === "WAIT") return;
    if (f.message === "MANY_TOOLS") {
      for (let i = 0; i < 40; i++) {
        const toolCallId = `many-${i}`;
        output({type:'tool_execution_start',toolCallId,toolName:i===39?'todo':'read',args:{path:`file-${i}`}});
        output({type:'tool_execution_update',toolCallId,partialResult:{content:[{type:'text',text:'stream-start'}]}});
        output({type:'tool_execution_update',toolCallId,partialResult:{content:[{type:'text',text:'stream-start\nstream-end'}]}});
        output({type:'tool_execution_end',toolCallId,result:i===39?{details:{phases:[{name:'Final',tasks:[{content:'Fortieth tool kept',status:'completed'}]}]}}:{content:[{type:'text',text:'中文🙂'.repeat(i===38?30000:2000)+`END_MARKER_${i}`}]}});
      }
      complete('FORTY_TOOLS_OK');return;
    }
    if (f.message === "APPROVAL") {
      output({
        type: "extension_ui_request",
        id: "approval-1",
        method: "select",
        title: "Allow tool: write",
        options: ["Approve Once", "Always Approve", "Deny"],
      });
      return;
    }
    if (f.message === "RICH") {
      output({
        type: "extension_ui_request",
        id: "rich-1",
        method: "input",
        title: "Enter secret",
      });
      return;
    }
    output({
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "todo",
      args: { op: "init", list: [{ phase: "Verify", items: ["Run checks"] }] },
    });
    output({
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "todo",
      result: {
        details: {
          phases: [
            {
              name: "Verify",
              tasks: [{ content: "Run checks", status: "completed" }],
            },
          ],
        },
      },
    });
    complete("OMP_NATIVE_OK");
  }
  if (f.type === "extension_ui_response") {
    complete(
      f.id === "rich-1" && f.cancelled
        ? "RICH_CANCELLED"
        : f.value === "Approve Once"
          ? "APPROVED_ONCE"
          : "DENIED",
    );
  }
  if (f.type === "abort") {
    reply({});
  }
});
