import { createHash } from "node:crypto";
import { posix } from "node:path";
import { validSSH, machineKey } from "../core/ssh.js";

const MAX_TEXT = 1024 * 1024;
const MAX_PROJECTS = 1000;
const plain = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const safeText = (value, max) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  !/[\x00-\x1f\x7f]/.test(value);
const validCwd = (value) => safeText(value, 4096) && value.startsWith("/");
function invalid(message) {
  throw Object.assign(new Error(message), { code: "INVALID_IMPORT" });
}
function json(text, source) {
  if (
    typeof text !== "string" ||
    !text.length ||
    Buffer.byteLength(text, "utf8") > MAX_TEXT
  )
    invalid(`${source} must be nonempty JSON text of at most 1 MiB`);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    invalid(`${source} is not valid JSON`);
  }
  if (!plain(value)) invalid(`${source} must be a JSON object`);
  return value;
}

/** Parse only inert SSH connection data, never SSH options or shell commands. */
export function parseSSHTarget(target) {
  if (!safeText(target, 512) || /\s|%/.test(target)) return null;
  let user;
  let port;
  let host;
  if (target.startsWith("ssh://")) {
    const match =
      /^ssh:\/\/(?:(?<user>[^@/:]+)@)?(?<host>\[[0-9A-Fa-f:]+\]|[A-Za-z0-9][A-Za-z0-9_.-]*)(?::(?<port>[0-9]+))?\/?$/.exec(
        target,
      );
    if (!match) return null;
    ({ user, host } = match.groups);
    if (match.groups.port !== undefined) port = Number(match.groups.port);
  } else {
    const parts = target.split("@");
    if (parts.length > 2) return null;
    if (parts.length === 2) [user, host] = parts;
    else [host] = parts;
  }
  if (host?.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const result = {
    host,
    ...(user === undefined ? {} : { user }),
    ...(port === undefined ? {} : { port }),
  };
  return validSSH(result) ? result : null;
}

/** Pure static import planner for official Herdr v0.9.5 persisted schemas. */
export function buildHerdrPreview(input, state) {
  if (!plain(input)) invalid("Import input must be an object");
  const { machinesText, sessionText, projectMachineId } = input;
  if (machinesText === undefined && sessionText === undefined)
    invalid("Supply machinesText or sessionText");
  const warnings = [];
  let omittedWarnings = 0;
  const warn = (message) => {
    if (warnings.length < 200) warnings.push(message);
    else omittedWarnings++;
  };
  const machines = [];
  const projects = [];
  const seenMachines = new Set(
    state.machines.filter((machine) => machine.type === "ssh").map(machineKey),
  );
  const seenProjects = new Set(
    state.projects.map((project) =>
      JSON.stringify([project.machineId, project.cwd]),
    ),
  );

  if (machinesText !== undefined) {
    const catalog = json(machinesText, "Machine catalog");
    if (catalog.version !== 1)
      invalid("Only Herdr machine catalog version 1 is supported");
    if (!Array.isArray(catalog.ssh) || catalog.ssh.length > 64)
      invalid("Machine catalog ssh must be an array of at most 64 profiles");
    if (
      catalog.selected_profile !== undefined &&
      catalog.selected_profile !== null &&
      (typeof catalog.selected_profile !== "string" ||
        !/^[a-f0-9]{32}$/.test(catalog.selected_profile))
    )
      invalid("Invalid machine catalog selected_profile");
    warn(
      "Herdr session selections, credentials, commands, environment and native agent references are not migrated; machines use an independent tmux backend.",
    );
    catalog.ssh.forEach((profile, index) => {
      const label = `Machine profile ${index + 1}`;
      if (
        !plain(profile) ||
        typeof profile.id !== "string" ||
        !/^[a-f0-9]{32}$/.test(profile.id) ||
        !safeText(profile.label, 128) ||
        Buffer.byteLength(profile.label, "utf8") > 128 ||
        !safeText(profile.session, 64) ||
        !/^[A-Za-z0-9_.-]+$/.test(profile.session) ||
        [".", ".."].includes(profile.session) ||
        typeof profile.enabled !== "boolean"
      ) {
        warn(`${label}: skipped invalid profile fields.`);
        return;
      }
      if (!profile.enabled) {
        warn(`${label}: skipped disabled profile.`);
        return;
      }
      const target = parseSSHTarget(profile.target);
      if (!target) {
        warn(`${label}: skipped unsupported or unsafe SSH target.`);
        return;
      }
      const key = machineKey(target);
      const action = seenMachines.has(key) ? "duplicate" : "add";
      if (action === "duplicate")
        warn(
          `${label}: duplicate SSH connection; Herdr session selection is not migrated.`,
        );
      seenMachines.add(key);
      machines.push({ name: profile.label, ...target, action });
    });
  }

  if (sessionText !== undefined) {
    if (
      typeof projectMachineId !== "string" ||
      !state.machines.some((machine) => machine.id === projectMachineId)
    )
      invalid(
        "Session import requires an explicit existing projectMachineId; no local default is inferred",
      );
    const session = json(sessionText, "Session snapshot");
    if (session.version !== 3)
      invalid(
        "Only Herdr session snapshot version 3 is supported (legacy and future versions are not imported)",
      );
    if (
      !Array.isArray(session.workspaces) ||
      session.workspaces.length > MAX_PROJECTS
    )
      invalid("Session workspaces must be an array of at most 1000 entries");
    warn(
      "Only static project paths are imported onto the explicitly selected machine; Herdr panes, sessions, agents, commands and environment are not resumed.",
    );
    const addProject = (cwd, workspace, label) => {
      if (!validCwd(cwd)) {
        warn(`${label}: skipped unsupported or non-absolute project path.`);
        return;
      }
      if (projects.length >= MAX_PROJECTS)
        invalid("Session contains more than 1000 project paths");
      const name = safeText(workspace.custom_name, 100)
        ? workspace.custom_name
        : posix.basename(cwd).slice(0, 100) || "Project";
      const key = JSON.stringify([projectMachineId, cwd]);
      const action = seenProjects.has(key) ? "duplicate" : "add";
      seenProjects.add(key);
      projects.push({ name, cwd, machineId: projectMachineId, action });
    };
    session.workspaces.forEach((workspace, index) => {
      const label = `Workspace ${index + 1}`;
      if (!plain(workspace)) {
        warn(`${label}: skipped invalid workspace.`);
        return;
      }
      if (
        workspace.identity_cwd !== undefined &&
        workspace.identity_cwd !== null &&
        workspace.identity_cwd !== ""
      ) {
        addProject(workspace.identity_cwd, workspace, label);
        return;
      }
      warn(
        `${label}: no identity_cwd; direct tab pane paths are treated as independent project candidates.`,
      );
      if (!Array.isArray(workspace.tabs)) {
        warn(`${label}: skipped missing or invalid tabs.`);
        return;
      }
      for (const tab of workspace.tabs) {
        if (!plain(tab) || !plain(tab.panes)) {
          warn(`${label}: skipped invalid tab panes.`);
          continue;
        }
        for (const [paneId, pane] of Object.entries(tab.panes)) {
          if (!/^[0-9]+$/.test(paneId) || !plain(pane)) {
            warn(`${label}: skipped invalid pane entry.`);
            continue;
          }
          addProject(pane.cwd, workspace, label);
        }
      }
    });
  }
  if (omittedWarnings)
    warnings.push(`${omittedWarnings} additional warnings omitted.`);
  const summary = {
    machines: machines.filter((item) => item.action === "add").length,
    projects: projects.filter((item) => item.action === "add").length,
    duplicates: [...machines, ...projects].filter(
      (item) => item.action === "duplicate",
    ).length,
  };
  const machineConfig = state.machines
    .map(({ id, name, type, host, user, port }) => ({
      id,
      name,
      type,
      host,
      user,
      port,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const projectConfig = state.projects
    .map(({ id, name, machineId, cwd, source }) => ({
      id,
      name,
      machineId,
      cwd,
      source,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const preview = { machines, projects, warnings, summary };
  const sourceHashes = [machinesText, sessionText].map((value) =>
    value === undefined
      ? null
      : createHash("sha256").update(value, "utf8").digest("hex"),
  );
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        format: 1,
        sourceHashes,
        projectMachineId: sessionText === undefined ? null : projectMachineId,
        machineConfig,
        projectConfig,
        preview,
      }),
    )
    .digest("hex");
  return { digest, ...preview };
}
