import { useEffect, useState } from "react";
import { announcement, escapeLabels, FOCUSABLE, tabTarget } from "../a11y";
import { useJobs } from "../state/stores";

const shown = (el: HTMLElement) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };

/**
 * Every modal dialog (`role="dialog" aria-modal="true"`) gets the keyboard behaviour a screen-reader or keyboard user expects,
 * without each dialog having to implement it: focus moves into the dialog when it opens, Tab and Shift+Tab stay inside it,
 * Escape presses its Close (or Done / OK; Cancel only when nothing in it is running), and focus returns to whatever opened it.
 */
export function ModalFocus() {
  useEffect(() => {
    const stack: { dialog: HTMLElement; opener: Element | null }[] = [];
    const reachable = (d: HTMLElement) => [...d.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(shown);
    const sync = () => {
      const open = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')];
      for (const d of open) {
        if (stack.some((s) => s.dialog === d)) continue;
        stack.push({ dialog: d, opener: document.activeElement });
        if (!d.contains(document.activeElement)) (reachable(d)[0] ?? d).focus({ preventScroll: true });
      }
      for (let i = stack.length - 1; i >= 0; i--) {
        const s = stack[i]!;
        if (s.dialog.isConnected) continue;
        stack.splice(i, 1);
        if (s.opener instanceof HTMLElement && s.opener.isConnected && stack.length === 0 && !document.activeElement?.closest("input, textarea, select")) s.opener.focus({ preventScroll: true });
      }
    };
    const onKey = (e: KeyboardEvent) => {
      const top = stack[stack.length - 1]?.dialog;
      if (!top || e.defaultPrevented) return;
      if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const list = reachable(top);
        const to = tabTarget(list.length, list.indexOf(document.activeElement as HTMLElement), e.shiftKey);
        if (list.length === 0) { e.preventDefault(); top.focus(); }
        else if (to !== null) { e.preventDefault(); list[to]!.focus(); }
      } else if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        const busy = !!top.querySelector('[role="status"], progress, [aria-busy="true"]');
        const buttons = [...top.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
        for (const label of escapeLabels(busy)) {
          const b = buttons.find((x) => (x.textContent ?? "").trim() === label);
          if (b) { e.preventDefault(); b.click(); return; }
        }
      }
    };
    const mo = new MutationObserver(sync);
    mo.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("keydown", onKey);
    sync();
    return () => { mo.disconnect(); document.removeEventListener("keydown", onKey); };
  }, []);
  return null;
}

/** Says out loud (polite live region) when a job starts, passes each quarter, and finishes, fails or is cancelled. */
export function JobAnnouncer() {
  const [message, setMessage] = useState("");
  useEffect(() => {
    const last = new Map<string, string>();
    return useJobs.subscribe((s, prev) => {
      for (const id of s.order) {
        const job = s.jobs[id];
        if (!job || job === prev.jobs[id]) continue;
        const r = announcement(job, last.get(id));
        last.set(id, r.last);
        if (r.say) setMessage(r.say);
      }
    });
  }, []);
  return <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-job-announcement>{message}</div>;
}
