import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { fmtShortcut, MOD_KEY, SHIFT_KEY } from "@/lib/platform";
import { AgentLauncherPanel } from "@/modules/agents/components/AgentLauncherPanel";
import type { AgentLaunchRequest } from "@/modules/agents/lib/launcher";
import { refreshHosts, useHostStore, type SshHost } from "@/modules/hosts";
import {
  AiBrowserIcon,
  ArrowRight01Icon,
  ComputerTerminal02Icon,
  ContainerTruckIcon,
  GitBranchIcon,
  Globe02Icon,
  IncognitoIcon,
  PencilEdit02Icon,
  PlusSignIcon,
  ServerStack03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";

type Props = {
  onNew: () => void;
  onNewBlock: () => void;
  onNewPrivate: () => void;
  onNewPreview: () => void;
  onNewEditor: () => void;
  onNewGitGraph: () => void;
  onNewSshHost?: (host: SshHost) => void;
  onNewDockerExec?: (host: SshHost) => void;
  onNewZellijHost?: (host: SshHost) => void;
  onLaunchAgents: (request: AgentLaunchRequest) => void;
};

export function NewTabMenu({
  onNew,
  onNewBlock,
  onNewPrivate,
  onNewPreview,
  onNewEditor,
  onNewGitGraph,
  onNewSshHost,
  onNewDockerExec,
  onNewZellijHost,
  onLaunchAgents,
}: Props) {
  const hosts = useHostStore((s) => s.hosts);
  useEffect(() => {
    if (hosts.length === 0) void refreshHosts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [menuOpen, setMenuOpen] = useState(false);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const openLauncherAfterMenuClose = useRef(false);
  const openMenuAfterLauncherClose = useRef(false);

  const onMenuOpenChange = (next: boolean) => {
    if (next) {
      openLauncherAfterMenuClose.current = false;
      setLauncherOpen(false);
    }
    setMenuOpen(next);
  };

  const openLauncher = () => {
    openLauncherAfterMenuClose.current = true;
  };

  const backToMenu = () => {
    openMenuAfterLauncherClose.current = true;
    setLauncherOpen(false);
  };

  return (
    <Popover open={launcherOpen} onOpenChange={setLauncherOpen}>
      <PopoverAnchor asChild>
        <span className="inline-flex">
          <DropdownMenu open={menuOpen} onOpenChange={onMenuOpenChange}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="ml-1 size-6 shrink-0 rounded-full bg-foreground/[0.06] text-muted-foreground ring-1 ring-inset ring-foreground/[0.04] hover:bg-foreground/[0.12] hover:text-foreground"
                title="New tab"
              >
                <HugeiconsIcon icon={PlusSignIcon} size={14} strokeWidth={2} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="min-w-44"
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                if (!openLauncherAfterMenuClose.current) return;

                openLauncherAfterMenuClose.current = false;
                requestAnimationFrame(() => setLauncherOpen(true));
              }}
            >
              <DropdownMenuItem onSelect={onNew}>
                <HugeiconsIcon
                  icon={ComputerTerminal02Icon}
                  size={14}
                  strokeWidth={1.75}
                />
                <span className="flex-1">Terminal</span>
                <span className="text-xs text-muted-foreground">
                  {fmtShortcut(MOD_KEY, "T")}
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onNewBlock}>
                <HugeiconsIcon
                  icon={ComputerTerminal02Icon}
                  size={14}
                  strokeWidth={1.75}
                />
                <span className="flex-1">Blocks</span>
                <span className="text-xs text-muted-foreground">
                  {fmtShortcut(MOD_KEY, SHIFT_KEY, "T")}
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={openLauncher}>
                <HugeiconsIcon
                  icon={AiBrowserIcon}
                  size={14}
                  strokeWidth={1.75}
                />
                <span className="flex-1">Agents</span>
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  size={14}
                  strokeWidth={1.75}
                  className="text-muted-foreground"
                />
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onNewPrivate}>
                <HugeiconsIcon
                  icon={IncognitoIcon}
                  size={14}
                  strokeWidth={1.75}
                />
                <span className="flex-1">Privacy</span>
                <span className="text-xs text-muted-foreground">
                  {fmtShortcut(MOD_KEY, "R")}
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onNewEditor}>
                <HugeiconsIcon
                  icon={PencilEdit02Icon}
                  size={14}
                  strokeWidth={1.75}
                />
                <span className="flex-1">Editor</span>
                <span className="text-xs text-muted-foreground">
                  {fmtShortcut(MOD_KEY, "E")}
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onNewPreview}>
                <HugeiconsIcon
                  icon={Globe02Icon}
                  size={14}
                  strokeWidth={1.75}
                />
                <span className="flex-1">Preview</span>
                <span className="text-xs text-muted-foreground">
                  {fmtShortcut(MOD_KEY, "P")}
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onNewGitGraph}>
                <HugeiconsIcon
                  icon={GitBranchIcon}
                  size={14}
                  strokeWidth={1.75}
                />
                <span className="flex-1">Git Graph</span>
              </DropdownMenuItem>
              {onNewSshHost && hosts.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  {hosts.map((host) => (
                    <DropdownMenuItem
                      key={host.id}
                      onSelect={() => onNewSshHost(host)}
                    >
                      <HugeiconsIcon
                        icon={ServerStack03Icon}
                        size={14}
                        strokeWidth={1.75}
                      />
                      <span className="flex-1 truncate">
                        SSH: {host.alias}
                      </span>
                    </DropdownMenuItem>
                  ))}
                </>
              )}
              {onNewDockerExec && hosts.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <div className="px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                    Docker exec
                  </div>
                  {hosts.map((host) => (
                    <DropdownMenuItem
                      key={`docker-${host.id}`}
                      onSelect={() => onNewDockerExec(host)}
                    >
                      <HugeiconsIcon
                        icon={ContainerTruckIcon}
                        size={14}
                        strokeWidth={1.75}
                      />
                      <span className="flex-1 truncate">
                        Exec on {host.alias}…
                      </span>
                    </DropdownMenuItem>
                  ))}
                </>
              )}
              {onNewZellijHost && hosts.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <div className="px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                    Zellij sessions
                  </div>
                  {hosts.map((host) => (
                    <DropdownMenuItem
                      key={`zellij-${host.id}`}
                      onSelect={() => onNewZellijHost(host)}
                    >
                      <HugeiconsIcon
                        icon={ComputerTerminal02Icon}
                        size={14}
                        strokeWidth={1.75}
                      />
                      <span className="flex-1 truncate">
                        Sessions on {host.alias}…
                      </span>
                    </DropdownMenuItem>
                  ))}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={6}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!openMenuAfterLauncherClose.current) return;

          openMenuAfterLauncherClose.current = false;
          requestAnimationFrame(() => setMenuOpen(true));
        }}
        className="w-[340px] gap-0 overflow-hidden rounded-2xl p-1.5"
      >
        <AgentLauncherPanel
          onBack={backToMenu}
          onLaunch={(request) => {
            setLauncherOpen(false);
            onLaunchAgents(request);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
