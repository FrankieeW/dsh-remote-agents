import React, { useState } from "react";
import { todoProgress } from "./tool-presentation.js";
import { IconChecklistOutlineRegular, IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, StateDot } from "./native.js";

const STATE = Object.freeze({ completed: "done", in_progress: "ongoing", pending: "idle" });
const LABEL = Object.freeze({ completed: "Completed", in_progress: "In progress", pending: "Pending" });

export function TodoList({ todos }) {
  return <ul className="agent-chat-todo-list">
    {todos.map((item, index) => <li key={`${index}:${item.content}`} className="agent-chat-todo-item" data-status={item.status}>
      <span className="agent-chat-todo-glyph" role="img" aria-label={LABEL[item.status]}><StateDot state={STATE[item.status]} /></span>
      <span className="agent-chat-todo-content">{item.content}</span>
    </li>)}
  </ul>;
}

/** The agent's latest to-do list, docked above the composer like DSH's own. */
export function TodoDock({ todos }) {
  const [collapsed, setCollapsed] = useState(true);
  if (!todos?.length) return null;
  return <section className="agent-chat-todo-dock" aria-label="To-dos">
    <button type="button" className="agent-chat-todo-header" aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)}>
      <span className="agent-chat-todo-lead" aria-hidden="true"><IconChecklistOutlineRegular /></span>
      <span className="agent-chat-todo-title">To-dos</span>
      <span className="agent-chat-todo-progress">{todoProgress(todos)}</span>
      <span className="agent-chat-todo-chevron" aria-hidden="true">{collapsed ? <IconChevronUpOutlineRegular /> : <IconChevronDownOutlineRegular />}</span>
    </button>
    {!collapsed && <TodoList todos={todos} />}
  </section>;
}
