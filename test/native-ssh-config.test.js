import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeBackend } from "../src/native/client.js";

// node --test runs each file in its own process, so HOME can point at a private fixture.
const home = await mkdtemp(join(tmpdir(), "dsh-ssh-home-"));
process.env.HOME = home;

test("SSH config aliases are offered with declared details and marked when already added", async (t) => {
  await mkdir(join(home, ".ssh"), { recursive: true });
  await writeFile(join(home, ".ssh", "config"), "Host dev\n  HostName 10.0.0.5\n  User alice\nHost build *.corp\nMatch exec \"touch should-not-run\"\nHost old\n");
  const backend = new NativeBackend({ statePath: join(home, "state", "fleet.json") });
  t.after(async () => {
    await backend.close();
    await rm(home, { recursive: true, force: true });
  });
  const call = (method, params = {}) => backend.request(method, params);
  const dev = await call("addMachine", { target: "DEV" });
  const { hosts, warnings } = await call("sshConfigHosts");
  assert.deepEqual(hosts.map((h) => h.alias), ["dev", "build", "old"]);
  assert.deepEqual([hosts[0].hostName, hosts[0].user, hosts[0].machineId], ["10.0.0.5", "alice", dev.id]);
  assert.equal(hosts[1].machineId, undefined);
  assert.deepEqual(warnings, []);
});
