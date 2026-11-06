// Minimal DOM stand-ins for DSH's shared primitives. Tests exercise plugin
// behavior; the real primitives are supplied by the DSH shell at runtime.
import React from "react";

const icon = (name) => function Icon({ className }) {
  return <svg data-icon={name} className={className} aria-hidden="true" />;
};

export const IconApiOutlineRegular = icon("api");
export const IconArchiveCheckOutlineRegular = icon("archive-check");
export const IconArchiveOffOutlineRegular = icon("archive-off");
export const IconArchiveOutlineRegular = icon("archive");
export const IconBranchOutlineRegular = icon("branch");
export const IconBrowseOutlineRegular = icon("browse");
export const IconCheckOutlineRegular = icon("check");
export const IconChecklistOutlineRegular = icon("checklist");
export const IconChevronDownOutlineRegular = icon("chevron-down");
export const IconChevronUpOutlineRegular = icon("chevron-up");
export const IconCloseFillRegular = icon("close");
export const IconCopyOutlineRegular = icon("copy");
export const IconEditOutlineRegular = icon("edit");
export const IconEllipsisOutlineRegular = icon("ellipsis");
export const IconFolderCloseRegular = icon("folder-close");
export const IconFolderOpenRegular = icon("folder-open");
export const IconGlobeOutlineRegular = icon("globe");
export const IconNewChatOutlineRegular = icon("new-chat");
export const IconPinFillRegular = icon("pin-fill");
export const IconPinOutlineRegular = icon("pin");
export const IconProjectAddOutlineRegular = icon("project-add");
export const IconQueueOutlineRegular = icon("queue");
export const IconSearchOutlineRegular = icon("search");
export const IconShieldOutlineRegular = icon("shield");
export const IconSlidersTwoOutlineRegular = icon("sliders");
export const IconSparkleRegular = icon("sparkle");
export const IconTriangleRightFillRegular = icon("triangle");
export const IconUnarchiveOutlineRegular = icon("unarchive");
export const IconUsersOutlineRegular = icon("users");
export const IconWorkspaceTreeOutlineRegular = icon("workspace-tree");

export function Tooltip({ children }) { return children; }
export function HoverCard({ anchor }) { return anchor; }
export function StateDot({ state }) { return <span data-state-dot={state} aria-hidden="true" />; }
export function TextShimmer({ children, className }) { return <span className={className}>{children}</span>; }
export function MarkdownText({ text }) { return <div data-markdown="">{text}</div>; }
export function UserMessageBubble({ className, ...rest }) { return <div className={className} {...rest} />; }
export function TerminalBlock({ command, output }) { return <pre data-terminal="">{`$ ${command}\n${output ?? ""}`}</pre>; }
export function DiffBlock({ diffs }) {
  return <pre data-diff="">{diffs.map((diff) => `${diff.path}\n-${diff.oldText ?? ""}\n+${diff.newText}`).join("\n")}</pre>;
}
export async function writeClipboard() { return true; }

export const Button = React.forwardRef(function Button({ variant, size, icon: leading, className, children, ...rest }, ref) {
  return <button ref={ref} type="button" className={className} data-variant={variant} data-size={size} {...rest}>{leading}{children}</button>;
});

export function Menu({ open, anchor, items = [], selectedIds = [], onSelect }) {
  return <span data-menu="">
    {anchor}
    {open && <div role="menu">{items.map((item) => {
      if (item.type === "separator") return <hr key={item.id} />;
      if (item.type === "label") return <div key={item.id} role="presentation">{item.text}</div>;
      return <button key={item.id} type="button" role="menuitem" data-id={item.id} disabled={item.disabled}
        aria-checked={selectedIds.includes(item.id)} onClick={() => onSelect?.(item.id)}>{item.icon}{item.label}</button>;
    })}</div>}
  </span>;
}

export function DisclosureRow({ icon: leading, title, open, expandable, onToggle, collapsedContent, keepContentWhenOpen, children, className }) {
  return <div className={className} data-open={open || undefined}>
    <div data-disclosure-row="" role={expandable ? "button" : undefined} aria-expanded={expandable ? open : undefined}
      onClick={expandable ? onToggle : undefined}>
      {leading}<span>{title}</span>{(keepContentWhenOpen || !open) && collapsedContent}
    </div>
    {open && children}
  </div>;
}
