import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "@phosphor-icons/react";
import { initials } from "./conversation-model";

export function Avatar({ name, large = false }: { name: string; large?: boolean }) {
  const tone = [...name].reduce((sum, letter) => sum + letter.charCodeAt(0), 0) % 4;
  return <span className={`avatar avatar-${tone}${large ? " avatar-large" : ""}`} aria-hidden="true">{initials(name)}</span>;
}

export function Modal({ title, children, onClose, busy = false, className = "" }: { title: string; children: ReactNode; onClose(): void; busy?: boolean; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const trigger = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    return () => { dialog?.close(); trigger?.focus(); };
  }, []);
  return <dialog ref={ref} className={`modal ${className}`} aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="modal-heading"><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" aria-label="Fermer" onClick={onClose} disabled={busy}><X /></button></div>
    {children}
  </dialog>;
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon">{icon}</span><h3>{title}</h3>{children}</div>;
}
