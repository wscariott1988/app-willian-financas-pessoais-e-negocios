import React, { useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  ariaLabel?: string;
}

export const Modal: React.FC<ModalProps> = ({ open, onClose, children, ariaLabel }) => {
  const contentRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Lock body scroll when open
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  // Save + restore focus
  useEffect(() => {
    if (open) {
      previousFocus.current = document.activeElement as HTMLElement;
      requestAnimationFrame(() => {
        const first = contentRef.current?.querySelector<HTMLElement>(
          'input, select, textarea, button:not([aria-label="Fechar editor"]):not([type="hidden"])'
        );
        first?.focus();
      });
    } else if (previousFocus.current) {
      requestAnimationFrame(() => previousFocus.current?.focus());
    }
  }, [open]);

  // Escape key
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onCloseRef.current(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  // Focus trap
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !contentRef.current) return;
    const focusable = contentRef.current.querySelectorAll<HTMLElement>(
      'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }, []);

  if (!open) return null;

  return createPortal(
    <div
      className="modal-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
    >
      <div className="modal-content" ref={contentRef}>
        <div className="modal-content-scroll">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
};
