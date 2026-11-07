import React, { Fragment, useState } from "react";
import { todoProgress } from "./tool-presentation.js";
import { IconChecklistOutlineRegular, IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, StateDot } from "./native.js";

const STATE = Object.freeze({ completed: "done", in_progress: "ongoing", pending: "idle" });
const LABEL = Object.freeze({ completed: "Completed", in_progress: "In progress", pending: "Pending" });

export function TodoList({ todos }) {
  let phaseIndex = -1;
  return <ul className="agent-chat-todo-list">
    {todos.map((item, index) => <Fragment key={`${index}:${item.content}`}>
      {item.phase && item.phase !== todos[index - 1]?.phase && <li className="agent-chat-todo-phase" data-phase-tone={++phaseIndex % 3}>{item.phase}</li>}
      <li className="agent-chat-todo-item" data-status={item.status}>
      <span className="agent-chat-todo-glyph" role="img" aria-label={LABEL[item.status]}><StateDot state={STATE[item.status]} /></span>
      <span className="agent-chat-todo-content">{item.content}</span>
    </li></Fragment>)}
  </ul>;
}

/** The agent's latest to-do list, docked above the composer like DSH's own. */
export function TodoDock({ todos, label = "To-dos" }) {
  const [collapsed, setCollapsed] = useState(true);
  if (!todos?.length) return null;
  return <section className="agent-chat-todo-dock" aria-label={label}>
    <button type="button" className="agent-chat-todo-header" aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)}>
      <span className="agent-chat-todo-lead" aria-hidden="true"><IconChecklistOutlineRegular /></span>
      <span className="agent-chat-todo-title">{label}</span>
      <span className="agent-chat-todo-progress">{todoProgress(todos)}</span>
      <span className="agent-chat-todo-chevron" aria-hidden="true">{collapsed ? <IconChevronUpOutlineRegular /> : <IconChevronDownOutlineRegular />}</span>
    </button>
    {!collapsed && <TodoList todos={todos} />}
  </section>;
}
