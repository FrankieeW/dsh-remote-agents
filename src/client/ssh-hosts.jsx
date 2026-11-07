import React, { useEffect, useState } from "react";

/**
 * Loads Host aliases from the plugin host's SSH config while `enabled`.
 * `load` must be stable; failures leave no suggestions and an explanation.
 */
export function useSshHosts(load, enabled) {
  const [state, setState] = useState({ hosts: [], error: "" });
  useEffect(() => {
    if (!enabled || typeof load !== "function") return undefined;
    let cancelled = false;
    load().then(
      (value) => {
        if (!cancelled) setState({ hosts: Array.isArray(value?.hosts) ? value.hosts : [], error: "" });
      },
      (error) => {
        if (!cancelled) setState({ hosts: [], error: error?.message || "SSH config suggestions are unavailable." });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [load, enabled]);
  return state;
}

function detail(host) {
  const target = host.hostName || (host.user || host.port ? host.alias : "");
  const address = target ? `${host.user ? `${host.user}@` : ""}${target}${host.port ? `:${host.port}` : ""}` : "";
  return [address, host.removed && "removed machine · adding it restores it"].filter(Boolean).join(" · ");
}

/** Aliases that are not saved machines yet; removed machines are restored by adding them. */
export function SshHostOptions({ id, hosts }) {
  return (
    <datalist id={id}>
      {hosts
        .filter((host) => !host.machineId || host.removed)
        .map((host) => (
          <option key={host.alias} value={host.alias}>
            {detail(host)}
          </option>
        ))}
    </datalist>
  );
}
