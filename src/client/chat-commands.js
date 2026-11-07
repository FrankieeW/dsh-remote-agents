/** Slash commands are interpreted locally only for completion; Rust owns execution. */
export function commandInput(text, commands = []) {
  const value = String(text || "").trimStart();
  if (!value.startsWith("/")) return null;
  const match = /^\/([^\s]*)([\s\S]*)$/.exec(value);
  const name = match[1];
  return {
    name,
    exact: commands.find(command => command.name === name),
    matches: commands.filter(command => command.name.startsWith(name)),
    hasArguments: !!match[2].trim(),
  };
}

export function commandUnavailable(command, { active, closed }) {
  if (closed && !command.allowClosed) return "This command needs an open session.";
  if (active && !command.allowActive) return "Wait for the current turn to finish, or use /stop.";
  return "";
}

export function downloadChatFile(file) {
  const url = URL.createObjectURL(new Blob([file.content], { type: file.mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
