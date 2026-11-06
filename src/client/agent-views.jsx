import React, { useState } from "react";
import { agentProfile } from "./agent-profiles.js";
import { toolMatches } from "./agent-view-data.js";
import { ToolCard } from "./chat-messages.jsx";
import { TodoList } from "./chat-todos.jsx";
import { todoProgress } from "./tool-presentation.js";
import {
  IconApiOutlineRegular,
  IconChecklistOutlineRegular,
  IconEditOutlineRegular,
  IconSparkleRegular,
} from "./native.js";

/** Mirrors the desktop conversation view row while keeping its state local. */
export function AgentViewTabs({ provider, view, onChange, data, idPrefix }) {
  const tabs = agentProfile(provider).views || [{ id: "chat", label: "Chat" }];
  const counts = {
    tools: data.records.length,
    tasks: data.todos.length,
    changes: data.changes.length,
  };
  return (
    <div
      className="agent-view-tabs"
      role="tablist"
      aria-label={`${agentProfile(provider).name} conversation views`}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        const index = tabs.findIndex((t) => t.id === view);
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : (index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) %
                tabs.length;
        onChange(tabs[next].id);
        event.currentTarget.querySelectorAll('[role="tab"]')[next]?.focus();
      }}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`${idPrefix}-${tab.id}`}
          aria-label={tab.label}
          aria-controls={`${idPrefix}-panel`}
          aria-selected={view === tab.id}
          tabIndex={view === tab.id ? 0 : -1}
          onClick={() => onChange(tab.id)}
        >
          <span>{tab.label}</span>
          {counts[tab.id] > 0 && (
            <span className="agent-view-count" aria-hidden="true">
              {counts[tab.id]}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export function AgentWelcome({ provider, workspace, onDraft }) {
  const profile = agentProfile(provider);
  return (
    <div className="agent-welcome-details">
      <p>{profile.welcome || "Start a conversation in this workspace."}</p>
      {workspace && <small>{workspace}</small>}
      <div
        className="agent-welcome-suggestions"
        aria-label={`${profile.name} suggested prompts`}
      >
        {(profile.suggestions || []).map((suggestion) => (
          <button
            key={suggestion.label}
            type="button"
            onClick={() => onDraft(suggestion.prompt)}
          >
            <IconSparkleRegular size={14} />
            <span>{suggestion.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function AgentDetailView({ session, view, data, onChat }) {
  const profile = agentProfile(session.provider);
  const [filter, setFilter] = useState("all");
  const [visible, setVisible] = useState(40);
  const changes = view === "changes";
  const records = (changes ? data.changes : data.records).filter(
    (record) => changes || toolMatches(record, filter),
  );
  const Icon =
    view === "tasks"
      ? IconChecklistOutlineRegular
      : changes
        ? IconEditOutlineRegular
        : IconApiOutlineRegular;
  const heading =
    view === "tasks"
      ? profile.taskLabel
      : changes
        ? "File changes"
        : `${profile.name} tools`;
  return (
    <section
      className="agent-detail-view"
      aria-label={`${profile.name} ${view === 'tasks' ? profile.taskLabel : changes ? 'changes' : 'tools'}`}
    >
      <header>
        <Icon size={18} />
        <h3>{heading}</h3>
      </header>
      {view === "tasks" ? (
        <>
          {data.todos.length ? (
            <>
              <p className="agent-chat-caption">
                Latest recorded list · {todoProgress(data.todos)}
              </p>
              <TodoList todos={data.todos} />
            </>
          ) : (
            <p className="agent-detail-empty">
              No recorded {session.provider === "codex" ? "plan" : "task"} items to show.
            </p>
          )}
        </>
      ) : (
        <>
          <p className="agent-chat-caption">
            {changes ? "Saved file-change records" : "Recorded tool activity"} ·{" "}
            {records.length} {records.length === 1 ? "record" : "records"}
          </p>
          {!changes && (
            <div
              className="agent-tool-filters"
              role="group"
              aria-label="Filter tool activity"
            >
              {[
                ["all", "All"],
                ["files", "Files"],
                ["commands", "Commands"],
                ...(session.provider === "claude"
                  ? [["agents", "Agents"]]
                  : []),
              ].map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={filter === id}
                  onClick={() => {
                    setFilter(id);
                    setVisible(40);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {records.length ? (
            <div className="agent-detail-records">
              {records.slice(0, visible).map((record) => (
                <ToolCard
                  key={record.key}
                  tool={record.tool}
                  cwd={session.cwd}
                  defaultOpen={changes}
                />
              ))}
            </div>
          ) : (
            <p className="agent-detail-empty">
              {changes
                ? "No file-change tool records have been saved yet."
                : "No recorded tools match this filter."}
            </p>
          )}
          {records.length > visible && (
            <button
              type="button"
              className="agent-detail-more"
              onClick={() => setVisible((n) => n + 40)}
            >
              Show more records ({records.length - visible} remaining)
            </button>
          )}
        </>
      )}
      {data.limited && (
        <p className="agent-chat-caption">
          Some tool records or details were shortened in the saved preview.{" "}
          <button type="button" className="agent-text-action" onClick={onChat}>
            Open conversation history
          </button>
        </p>
      )}
    </section>
  );
}
