import { mkdtemp, writeFile, chmod, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * OpenSSH test double. It never opens a network connection: the host name
 * selects the behaviour, and `loop-*` hosts run the remote command locally.
 * A `down-<host>` file in the directory makes that host refuse connections.
 */
const SSH = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_SSH_DIR/ssh.log"
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
shift
# Like OpenSSH, resolve host names case-insensitively.
host=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
cmd=$2
if [ -e "$FAKE_SSH_DIR/down-$host" ]; then
  echo "ssh: connect to host $host port 22: Connection refused" >&2; exit 255
fi
# lag-* hosts work like loop-* hosts after a delay, to widen race windows.
case "$host" in lag-*) sleep "\${FAKE_SSH_LAG:-0.5}"; host="loop-\${host#lag-}" ;; esac
case "$host" in
  slow-*) sleep "\${FAKE_SSH_SLEEP:-3}"; echo "ssh: connect to host $host port 22: Operation timed out" >&2; exit 255 ;;
  keyfail-*) echo "No ED25519 host key is known for $host and you have requested strict checking." >&2
    echo "Host key verification failed." >&2; exit 255 ;;
  changed-*) echo "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@" >&2
    echo "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @" >&2
    echo "Host key verification failed." >&2; exit 255 ;;
  denied-*) echo "$host: Permission denied (publickey)." >&2; exit 255 ;;
  loop-*|notmux-*)
    case "$cmd" in
      *"command -v "*codex*) echo "$FAKE_SSH_DIR/codex"; exit 0 ;;
      *"command -v "*) exit 0 ;;
    esac
    case "$host" in notmux-*) case "$cmd" in *"'tmux'"*) echo "sh: tmux: command not found" >&2; exit 127 ;; esac ;; esac
    # Like sshd, hand the command to the account's login shell.
    exec \${FAKE_LOGIN_SHELL:-/bin/sh} -c "$cmd" ;;
esac
echo "ssh: Could not resolve hostname $host: nodename nor servname provided, or not known" >&2
exit 255
`;

const CODEX = `#!/bin/sh
exec "$FAKE_NODE" "$FAKE_CODEX_FIXTURE" "$@"
`;

/** Prepends the double to PATH for every backend this test process spawns. */
export async function installFakeSsh() {
  const dir = await mkdtemp(join(tmpdir(), "dsh-fake-ssh-"));
  await writeFile(join(dir, "ssh"), SSH);
  await writeFile(join(dir, "codex"), CODEX);
  await chmod(join(dir, "ssh"), 0o755);
  await chmod(join(dir, "codex"), 0o755);
  Object.assign(process.env, {
    // Remote commands often run without a UTF-8 locale (LANG is not forwarded).
    LANG: "C",
    LC_ALL: "C",
    FAKE_SSH_DIR: dir,
    FAKE_NODE: process.execPath,
    FAKE_CODEX_FIXTURE: resolve("scripts/fixtures/codex-process.cjs"),
    PATH: `${dir}:${process.env.PATH}`,
  });
  return {
    dir,
    codex: join(dir, "codex"),
    down: (host) => writeFile(join(dir, `down-${host}`), ""),
    up: (host) => rm(join(dir, `down-${host}`), { force: true }),
    log: async () => (await readFile(join(dir, "ssh.log"), "utf8").catch(() => "")).split("\n"),
    remove: () => rm(dir, { recursive: true, force: true }),
  };
}
