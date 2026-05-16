import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  CommandIcon,
  FolderTreeIcon,
  PuzzleIcon,
  SourceCodeCircleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { SidebarViewId } from "./types";

export const SIDEBAR_RAIL_HEIGHT = 44;

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
};

export function SidebarRail({
  activeView,
  onSelectView,
  changedCount,
  onOpenCommandPalette,
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
      id: "command-palette",
      label: "Command Palette",
      icon: CommandIcon,
      onTrigger: onOpenCommandPalette,
    },
  ];

  return (
    <div
      style={{ height: SIDEBAR_RAIL_HEIGHT }}
      className="flex shrink-0 items-center justify-around gap-1 border-t border-border/60 bg-card/80 px-2 backdrop-blur"
    >
      {slots.map((slot) => {
        const isActive = slot.kind === "view" && slot.id === activeView;
        const button = (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={slot.label}
            className={cn(
              "relative size-8 cursor-pointer rounded-md text-muted-foreground transition-colors",
              isActive
                ? "bg-accent text-foreground shadow-inner"
                : "hover:bg-accent/60 hover:text-foreground",
            )}
            onClick={() => {
              if (slot.kind === "view") onSelectView(slot.id);
              else slot.onTrigger();
            }}
          >
            <HugeiconsIcon icon={slot.icon} size={17} strokeWidth={1.75} />
            {slot.kind === "view" && slot.badge && slot.badge > 0 ? (
              <span className="pointer-events-none absolute -right-0.5 -top-0.5 inline-flex min-w-3.5 items-center justify-center rounded-full bg-primary px-1 py-px text-[8px] font-semibold leading-none text-primary-foreground shadow-sm ring-1 ring-card">
                {slot.badge > 99 ? "99+" : slot.badge}
              </span>
            ) : null}
            {isActive ? (
              <span className="pointer-events-none absolute -bottom-1 left-1/2 h-0.5 w-4 -translate-x-1/2 rounded-full bg-primary" />
            ) : null}
          </Button>
        );
        return (
          <Tooltip key={slot.id}>
            <TooltipTrigger asChild>{button}</TooltipTrigger>
            <TooltipContent side="top" className="text-[10.5px]">
              {slot.label}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
