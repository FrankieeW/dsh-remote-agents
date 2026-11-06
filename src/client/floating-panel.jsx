import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** Escape sidebar/scroll clipping while staying inside the viewport. */
export function FloatingPanel({ anchor, width = 340, placement = 'bottom', children }) {
  const panel = useRef(null), [position, setPosition] = useState({ left: 8, top: 8 });
  const doc = anchor.current?.ownerDocument;
  useLayoutEffect(() => {
    if (!doc || !panel.current) return;
    const view = doc.defaultView;
    const measure = () => {
      const rect = anchor.current?.getBoundingClientRect(); if (!rect) return;
      const w = Math.min(width, view.innerWidth - 16), h = panel.current.getBoundingClientRect().height;
      const left = Math.max(8, Math.min(rect.right - w, view.innerWidth - w - 8));
      const preferred = placement === 'top' ? rect.top - h - 8 : rect.bottom + 8;
      const top = Math.max(8, Math.min(preferred, view.innerHeight - h - 8));
      setPosition(old => old.left === left && old.top === top ? old : { left, top });
    };
    measure(); view.addEventListener('resize', measure); doc.addEventListener('scroll', measure, true);
    const observer = view.ResizeObserver ? new view.ResizeObserver(measure) : null; observer?.observe(panel.current);
    return () => { observer?.disconnect(); view.removeEventListener('resize', measure); doc.removeEventListener('scroll', measure, true); };
  }, [doc, anchor, width, placement]);
  if (!doc) return null;
  return createPortal(<div ref={panel} className="agent-floating-panel" style={{ position: 'fixed', ...position, width: `min(${width}px, calc(100vw - 16px))`, zIndex: 1000 }}
    onPointerDown={event => event.stopPropagation()}>{children}</div>, doc.body);
}
