import { changedTerminalText } from "@/modules/terminal/ghostty/core/accessibleTerminalText";
import { useEffect, useState } from "react";
import type { GhosttyTerminalModelApi } from "@/modules/terminal/ghostty/GhosttyTerminalModel";
import { subscribeWindowPresentation } from "@/modules/terminal/ghostty/windowPresentation";

export default function TerminalAccessibleOutput({
  model,
  visible,
  focused,
  onExit,
}: {
  model: GhosttyTerminalModelApi;
  visible: boolean;
  focused: boolean;
  onExit: () => void;
}) {
  const [text, setText] = useState("");
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (!visible) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let presented = false;
    let previous = "";
    const update = () => {
      timer = null;
      if (!presented || model.isDisposed?.()) return;
      const start = model.viewportOriginLine();
      const next =
        model
          .readTextRange?.(start, start + Math.min(model.rows, 256) - 1)
          .slice(0, 64 * 1024) ?? "";
      setText(next);
      setAnnouncement(focused ? changedTerminalText(previous, next) : "");
      previous = next;
    };
    const schedule = () => {
      if (presented && timer === null) timer = setTimeout(update, 250);
    };
    const unlisten = subscribeWindowPresentation((state) => {
      presented = state.visible;
      if (presented) schedule();
      else if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    });
    const unsubscribe = model.subscribeDamage(schedule);
    return () => {
      unlisten();
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, [model, visible, focused]);

  return (
    <>
      <pre
        role="document"
        tabIndex={visible ? 0 : -1}
        aria-label="Terminal output. Page Up and Page Down browse history."
        className="sr-only focus:not-sr-only focus:absolute focus:inset-0 focus:z-20 focus:overflow-auto focus:bg-background focus:p-3 focus:text-foreground"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onExit();
            return;
          }
          if (event.key === "PageUp" || event.key === "PageDown") {
            event.preventDefault();
            event.stopPropagation();
            model.scrollBy((event.key === "PageUp" ? -1 : 1) * model.rows);
          } else if (event.key === "End" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            model.scrollToBottom();
          }
        }}
      >
        {text}
      </pre>
      <div
        className="sr-only"
        role="status"
        aria-live={visible && focused ? "polite" : "off"}
        aria-atomic="true"
      >
        {announcement}
      </div>
    </>
  );
}
