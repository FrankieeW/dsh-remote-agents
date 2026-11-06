import { isIP } from "node:net";

export function validHost(host) {
  return (
    typeof host === "string" &&
    host.length <= 253 &&
    (/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(host) || isIP(host) === 6)
  );
}
export function validUser(user) {
  return (
    user === undefined ||
    (typeof user === "string" && /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(user))
  );
}
export function validPort(port) {
  return (
    port === undefined || (Number.isInteger(port) && port >= 1 && port <= 65535)
  );
}
export function validSSH(machine) {
  return (
    validHost(machine.host) &&
    validUser(machine.user) &&
    validPort(machine.port)
  );
}
export function machineKey(machine) {
  return JSON.stringify([
    machine.host,
    machine.user ?? null,
    machine.port ?? null,
  ]);
}
