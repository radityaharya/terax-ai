import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  CommandIcon,
  FolderTreeIcon,
  Message01Icon,
  PuzzleIcon,
  SourceCodeCircleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { SidebarViewId } from "./types";

export const SIDEBAR_RAIL_HEIGHT = 48;

type RailSlot =
  | {
      kind: "view";
      id: SidebarViewId;
      label: string;
      icon: Parameters<typeof HugeiconsIcon>[0]["icon"];
      badge?: number;
    }
  | {
      kind: "action";
      id: string;
      label: string;
      icon: Parameters<typeof HugeiconsIcon>[0]["icon"];
      onTrigger: () => void;
    };

type Props = {
  activeView: SidebarViewId;
  onSelectView: (view: SidebarViewId) => void;
  changedCount: number;
  onOpenCommandPalette: () => void;
  onToggleMiniWindow: () => void;
  miniOpen: boolean;
};

export function SidebarRail({
  activeView,
  onSelectView,
  changedCount,
  onOpenCommandPalette,
  onToggleMiniWindow,
  miniOpen,
}: Props) {
  const slots: RailSlot[] = [
    {
      kind: "view",
      id: "explorer",
      label: "Files",
      icon: FolderTreeIcon,
    },
    {
      kind: "view",
      id: "source-control",
      label: "Source Control",
      icon: SourceCodeCircleIcon,
      badge: changedCount,
    },
    {
      kind: "view",
      id: "extensions",
      label: "Extensions",
      icon: PuzzleIcon,
    },
    {
      kind: "action",
      id: "ai-mini",
      label: miniOpen ? "Hide AI conversation" : "Open AI conversation",
      icon: Message01Icon,
      onTrigger: onToggleMiniWindow,
    },
    {
      kind: "action",
      id: "command-palette",
      label: "Command Palette",
      icon: CommandIcon,
      onTrigger: onOpenCommandPalette,
    },
  ];

  return (
    <div
      style={{ height: SIDEBAR_RAIL_HEIGHT }}
      className="flex shrink-0 items-center justify-around border-t border-border/60 bg-card/85 px-1.5 backdrop-blur"
    >
      {slots.map((slot) => {
        const isActive = slot.kind === "view" && slot.id === activeView;
        const isAction = slot.kind === "action";
        const isMiniOpen = slot.kind === "action" && slot.id === "ai-mini" && miniOpen;
        const showBadge =
          slot.kind === "view" && !!slot.badge && slot.badge > 0;
        return (
          <Tooltip key={slot.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={slot.label}
                aria-pressed={isActive || undefined}
                onClick={() => {
                  if (slot.kind === "view") onSelectView(slot.id);
                  else slot.onTrigger();
                }}
                className={cn(
                  "group relative inline-flex size-9 cursor-pointer items-center justify-center rounded-lg border outline-none transition-[background-color,border-color,color,box-shadow] duration-150",
                  "focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-0",
                  isActive
                    ? "border-border/70 bg-foreground/[0.07] text-foreground shadow-[inset_0_0_0_1px_rgba(255,255,255,0.02)] dark:bg-foreground/[0.09]"
                    : isMiniOpen
                      ? "border-border/60 bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.08] dark:bg-foreground/[0.08]"
                      : isAction
                        ? "border-transparent bg-foreground/[0.025] text-muted-foreground hover:border-border/60 hover:bg-foreground/[0.06] hover:text-foreground dark:bg-foreground/[0.04]"
                        : "border-transparent bg-foreground/[0.035] text-muted-foreground hover:border-border/55 hover:bg-foreground/[0.07] hover:text-foreground dark:bg-foreground/[0.05]",
                )}
              >
                <HugeiconsIcon
                  icon={slot.icon}
                  size={17}
                  strokeWidth={isActive ? 2 : 1.75}
                  className="transition-[stroke-width] duration-150"
                />
                {showBadge ? (
                  <span className="pointer-events-none absolute -right-1 -top-1 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[8.5px] font-semibold leading-none text-primary-foreground shadow-sm ring-2 ring-card">
                    {slot.badge! > 99 ? "99+" : slot.badge}
                  </span>
                ) : null}
                {isActive ? (
                  <span className="pointer-events-none absolute -bottom-[5px] left-1/2 h-[2px] w-5 -translate-x-1/2 rounded-full bg-primary" />
                ) : null}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-[10.5px]">
              {slot.label}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
