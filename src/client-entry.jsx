import React from "react";
import FleetPage from "./client/FleetPage.jsx";
import css from "./client/fleet.css";
import { CHANNEL } from "./rpc.js";

export const name = "remote-agents-client";
export const inject = ["slots", "connection"];
const PANEL = "remote-agents";

function FleetIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="7" rx="2" />
      <path d="M12 10v5M5 15h14M5 15v3m14-3v3" />
      <circle cx="5" cy="20" r="2" />
      <circle cx="19" cy="20" r="2" />
      <path d="M6 6.5h2m2 0h2" />
    </svg>
  );
}
export function apply(ctx) {
  const api = async (endpoint, payload = {}, signal) => {
    const result = await ctx.connection.rpc.call(
      CHANNEL,
      endpoint,
      payload,
      signal,
    );
    if (!result.ok) throw new Error(result.error?.message || "操作失败");
    return result.value;
  };
  ctx.effect(() => {
    const style = document.createElement("style");
    style.dataset.plugin = PANEL;
    style.textContent = css;
    document.head.appendChild(style);
    return () => style.remove();
  });
  ctx.slots.inject("main", () =>
    ctx.slots.register(
      { name: "main", key: PANEL, inject: () => ({ api }) },
      FleetPage,
    ),
  );
  ctx.slots.inject("sidebar.panellist", () =>
    ctx.slots.register(
      {
        name: "sidebar.panellist",
        id: PANEL,
        order: 20,
        label: "Agent 工作台",
      },
      FleetIcon,
    ),
  );
}
