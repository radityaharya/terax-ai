import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export type RowTone = "ok" | "warn" | "hot" | "muted" | "idle";

export type ResourceRowAction = {
  key: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  /** Destructive styling (remove/kill). */
  danger?: boolean;
  disabled?: boolean;
};

const TONE_DOT: Record<RowTone, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-400",
  hot: "bg-destructive",
  idle: "bg-muted-foreground/40",
  muted: "bg-muted-foreground/40",
};

/**
 * One resource in a list: a status dot, a title with an optional subtitle
 * and footer (stats, chips), and a set of hover-revealed actions.
 *
 * Shared by container rows, compose service rows, and swarm service rows so
 * every Docker resource reads and behaves identically. The actions are pure
 * presentation — callers own the lifecycle call and any confirmation.
 */
export function ResourceRow({
  tone = "muted",
  toneLabel,
  title,
  subtitle,
  footer,
  actions = [],
  onClick,
  active,
  className,
}: {
  tone?: RowTone;
  /** aria-label / title for the status dot (e.g. "running"). */
  toneLabel?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  footer?: ReactNode;
  actions?: ResourceRowAction[];
  onClick?: () => void;
  active?: boolean;
  className?: string;
}) {
  const interactive = Boolean(onClick);
  const row = (
    <div
      className={cn(
        "group relative flex items-start gap-2 rounded-md px-2 py-1.5 outline-none transition-colors",
        interactive &&
          "cursor-pointer hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-primary/40",
        !interactive && "hover:bg-accent/50",
        active && "bg-accent",
        className,
      )}
    >
      <span
        role="img"
        aria-label={toneLabel}
        title={toneLabel}
        className={cn("mt-1 size-2 shrink-0 rounded-full", TONE_DOT[tone])}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-1.5 text-[12px] font-medium leading-tight text-foreground">
          {title}
        </span>
        {subtitle ? (
          <span className="mt-0.5 block min-w-0 truncate text-[10px] leading-tight text-muted-foreground/60">
            {subtitle}
          </span>
        ) : null}
        {footer}
      </span>
      {actions.length > 0 ? (
        <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex group-focus-within:flex">
          {actions.map((a) => (
            <ResourceRowButton key={a.key} action={a} />
          ))}
        </span>
      ) : null}
    </div>
  );

  if (!interactive) return row;
  return (
    // biome-ignore lint/a11y/useSemanticElements: the row hosts nested action buttons, so it cannot be a <button>
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onClick?.();
        }
      }}
    >
      {row}
    </div>
  );
}

function ResourceRowButton({ action }: { action: ResourceRowAction }) {
  return (
    <button
      type="button"
      aria-label={action.label}
      title={action.label}
      disabled={action.disabled}
      onClick={(e) => {
        e.stopPropagation();
        action.onClick();
      }}
      className={cn(
        "flex size-5 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground",
        action.danger && "hover:text-destructive",
        action.disabled && "pointer-events-none opacity-40",
      )}
    >
      {action.icon}
    </button>
  );
}
