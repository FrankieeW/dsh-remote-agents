if (process.argv.includes("--version")) {
  console.log("2.1.318");
  process.exit(0);
}
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const f = JSON.parse(line);
  if (f.type !== "control_request") return;
  const subtype = f.request.subtype;
  const response =
    subtype === "initialize"
      ? {
          models: [
            {
              value: "fixture",
              displayName: "Fixture Claude",
              supportedEffortLevels: ["low", "high"],
            },
          ],
        }
      : subtype === "get_settings"
        ? {
            applied: {
              model: "fixture",
              effort: "low",
              permissionMode: "default",
            },
          }
        : {};
  process.stdout.write(
    JSON.stringify({
      type: "control_response",
      response: { subtype: "success", request_id: f.request_id, response },
    }) + "\n",
  );
});
