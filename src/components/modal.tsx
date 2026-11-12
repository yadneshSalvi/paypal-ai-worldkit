"use client";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
export function ModalFrame({ children, labelledBy, onClose, className = "", backdropClassName = "", returnFocusRef }: { children: ReactNode; labelledBy: string; onClose: () => void; className?: string; backdropClassName?: string; returnFocusRef?: RefObject<HTMLElement | null> }) {
  const element = useRef<HTMLDivElement>(null); const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null; const previousOverflow = document.body.style.overflow; document.body.style.overflow = "hidden";
    const first = element.current?.querySelector<HTMLElement>("button,input,select,textarea,[tabindex='0']"); first?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close.current(); }
      if (event.key === "Tab") {
        const focusable = Array.from(element.current?.querySelectorAll<HTMLElement>("button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex='0']") ?? []).filter(x => x.getClientRects().length > 0);
        if (!focusable.length) { event.preventDefault(); element.current?.focus(); return; }
        if (!element.current?.contains(document.activeElement)) { event.preventDefault(); focusable[0]?.focus(); return; }
        if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1)?.focus(); }
        if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0]?.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = previousOverflow; (returnFocusRef?.current ?? before)?.focus(); };
  }, [returnFocusRef]);
  return <div className={`modal-backdrop ${backdropClassName}`} onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div ref={element} tabIndex={-1} className={`modal ${className}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy}>{children}</div></div>;
}
