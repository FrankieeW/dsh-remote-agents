import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  herdrPaths,
  readImportSource,
  runImportCli,
} from "../src/import-cli.js";
import { resolveStatePath } from "../src/state-path.js";
import { apply as applySkill } from "../src/skill.js";

const catalog = JSON.stringify({
  version: 1,
  ssh: [
    {
      id: "a".repeat(32),
      label: "Build box",
      target: "ssh://dev@build.example:2222",
      session: "agents",
      enabled: true,
      secret: "DO_NOT_EXPOSE",
    },
  ],
});

test("offline CLI previews then requires exact confirmation; sources unchanged and no credential echo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-herdr-cli-"));
  const source = join(dir, "endpoints.json"),
    state = join(dir, "fleet.json");
  await writeFile(source, catalog);
  const invoke = async (args) => {
    let text = "";
    await runImportCli(args, {
      stdout: (value) => {
        text += value;
      },
    });
    return JSON.parse(text);
  };
  const before = await readFile(source, "utf8");
  const preview = await invoke([
    "preview",
    "--machines",
    source,
    "--state",
    state,
  ]);
  assert.equal(preview.summary.machines, 1);
  assert.equal(JSON.stringify(preview).includes("DO_NOT_EXPOSE"), false);
  await assert.rejects(access(state), { code: "ENOENT" });
  const empty = await invoke(["list", "--state", state]);
  assert.equal(empty.machines[0].id, "local");
  await assert.rejects(access(state), { code: "ENOENT" });
  await assert.rejects(
    invoke(["import", "--machines", source, "--state", state]),
    /confirm/,
  );
  await assert.rejects(access(state), { code: "ENOENT" });
  const imported = await invoke([
    "import",
    "--machines",
    source,
    "--state",
    state,
    "--confirm",
    preview.digest,
  ]);
  assert.equal(imported.imported.machines, 1);
  const listed = await invoke(["list", "--state", state]);
  assert.equal(listed.machines[1].user, "dev");
  assert.equal(listed.machines[1].port, 2222);
  assert.equal(listed.machines[1].id, imported.importedMachineIds[0]);
  assert.equal(await readFile(source, "utf8"), before);
  const again = await invoke([
    "preview",
    "--machines",
    source,
    "--state",
    state,
  ]);
  assert.equal(again.summary.machines, 0);
  assert.equal(again.summary.duplicates, 1);
});

test("CLI validates command/options, destination and source before mutation", async () => {
  const bad = [
    ["bogus"],
    ["paths", "--state", "x"],
    ["list", "--confirm", "x"],
    ["preview"],
    ["preview", "--machines", "x", "--machines", "y"],
    ["preview", "--session", "x"],
    ["preview", "--machines", "x", "--confirm", "a".repeat(64)],
  ];
  for (const args of bad)
    await assert.rejects(
      runImportCli(args, {
        createFleet: () => {
          throw new Error("UNEXPECTED FLEET");
        },
      }),
    );
  const dir = await mkdtemp(join(tmpdir(), "dsh-herdr-source-"));
  const path = join(dir, "source.json");
  await writeFile(path, Buffer.from([0xff, 0xfe]));
  await assert.rejects(readImportSource(path), /UTF-8/);
  await writeFile(path, "a".repeat(1024 * 1024 + 1));
  await assert.rejects(readImportSource(path), /1 MiB/);
  await assert.rejects(readImportSource(dir), /regular/);
});

test("default source and target discovery honors XDG and DSH overrides without reading files", () => {
  assert.equal(
    herdrPaths(
      { XDG_STATE_HOME: "/state", XDG_CONFIG_HOME: "/config" },
      "linux",
      "/home/test",
    ).machines,
    "/state/herdr/client/endpoints.json",
  );
  assert.equal(
    herdrPaths({}, "darwin", "/home/test").session,
    "/home/test/.config/herdr/session.json",
  );
  assert.equal(
    resolveStatePath(undefined, { DSH_HOME: "/dsh" }, "/home/test"),
    "/dsh/remote-agents/fleet.json",
  );
  assert.equal(
    resolveStatePath(
      undefined,
      { DSH_REMOTE_AGENTS_STATE: "/chosen.json" },
      "/home/test",
    ),
    "/chosen.json",
  );
});

test("bundled import skill registers in DSH and includes preview/consent safety", async () => {
  let provider;
  applySkill({
    skills: {
      registerProvider(factory) {
        provider = factory();
      },
    },
  });
  const [candidate] = await provider.list();
  assert.equal(candidate.name, "herdr-import");
  const skill = await provider.get(candidate);
  assert.match(skill.content, /--confirm/);
  assert.match(skill.content, /另行确认/);
  assert.match(skill.content, /不执行 `herdr`/);
  assert.equal(skill.invocation.modelInvocable, true);
});
