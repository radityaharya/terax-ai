import { DockerIcon } from "@/components/icons/DockerIcon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  FolderGitTwoIcon,
  FolderTreeIcon,
  ServerStack03Icon,
  Settings01Icon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import type { SidebarViewId } from "./types";

export const ACTIVITY_BAR_WIDTH = 44;

/** Renders an icon at the bar's weight, letting the active state thicken it. */
type IconRenderer = (active: boolean) => ReactNode;

type BarItem = {
  id: SidebarViewId;
  label: string;
  renderIcon: IconRenderer;
  badge?: number;
};

/** Hugeicons are stroked, so the active state nudges stroke width. */
function huge(icon: Parameters<typeof HugeiconsIcon>[0]["icon"]): IconRenderer {
  return (active) => (
    <HugeiconsIcon
      icon={icon}
      size={18}
      strokeWidth={active ? 2 : 1.75}
      className="shrink-0 transition-[stroke-width] duration-[var(--dur-base)]"
    />
  );
}

/** The Docker whale is a filled brand mark: no stroke to vary, so it just
 *  steps its opacity down when inactive. */
function dockerMark(active: boolean): ReactNode {
  return (
    <DockerIcon
      size={18}
      className={cn(
        "shrink-0 transition-opacity duration-[var(--dur-base)]",
        active ? "opacity-100" : "opacity-85",
      )}
    />
  );
}

type Props = {
  activeView: SidebarViewId;
  onSelectView: (view: SidebarViewId) => void;
  changedCount: number;
  onOpenSettings?: () => void;
};

/**
 * VS Code-style activity bar: a fixed icon strip pinned to the far left of
 * the window, OUTSIDE the collapsible sidebar. Living outside means view
 * switching stays reachable while the sidebar is collapsed (the old
 * bottom-of-sidebar rail disappeared with it), and labels move into
 * tooltips so a narrow sidebar never squeezes them.
 *
 * Clicking a view delegates to `cycleSidebarView`, which expands a
 * collapsed sidebar and collapses it again when the active view is
 * re-clicked.
 */
export function ActivityBar({
  activeView,
  onSelectView,
  changedCount,
  onOpenSettings,
}: Props) {
  const items: BarItem[] = [
    { id: "explorer", label: "Files", renderIcon: huge(FolderTreeIcon) },
    {
      id: "source-control",
      label: "Source control",
      renderIcon: huge(FolderGitTwoIcon),
      badge: changedCount,
    },
    { id: "hosts", label: "Hosts", renderIcon: huge(ServerStack03Icon) },
    { id: "docker", label: "Docker", renderIcon: dockerMark },
    { id: "zellij", label: "Zellij sessions", renderIcon: huge(TerminalIcon) },
  ];

  return (
    <nav
      aria-label="Sidebar views"
      style={{ width: ACTIVITY_BAR_WIDTH }}
      className="terax-pane terax-pane-flat-right ml-2 flex shrink-0 flex-col items-center gap-1 py-2"
    >
      {items.map((item) => (
        <ActivityBarButton
          key={item.id}
          label={item.label}
          renderIcon={item.renderIcon}
          badge={item.badge}
          active={item.id === activeView}
          onClick={() => onSelectView(item.id)}
        />
      ))}
      <span className="flex-1" />
      {onOpenSettings ? (
        <ActivityBarButton
          label="Settings"
          renderIcon={huge(Settings01Icon)}
          onClick={onOpenSettings}
        />
      ) : null}
    </nav>
  );
}

function ActivityBarButton({
  label,
  renderIcon,
  badge,
  active,
  onClick,
}: {
  label: string;
  renderIcon: IconRenderer;
  badge?: number;
  active?: boolean;
  onClick: () => void;
}) {
  const showBadge = !!badge && badge > 0;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={active}
          onClick={onClick}
          className={cn(
            "relative flex h-9 w-full cursor-pointer items-center justify-center outline-none transition-colors duration-[var(--dur-base)]",
            "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40",
            active
              ? "bg-foreground/[0.055] text-foreground"
              : "text-muted-foreground/75 hover:bg-foreground/[0.035] hover:text-foreground",
          )}
        >
          {active ? (
            <span
              aria-hidden
              className="absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-r-full bg-primary"
            />
          ) : null}
          {renderIcon(Boolean(active))}
          {showBadge ? (
            <span className="absolute right-1.5 top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9.5px] font-semibold leading-none tabular-nums text-primary-foreground">
              {badge > 99 ? "99+" : badge}
            </span>
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={6} className="text-[11px]">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
