import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IS_WINDOWS } from "@/lib/platform";
import { refreshHosts, useHostStore } from "@/modules/hosts";
import {
  LOCAL_WORKSPACE,
  useWorkspaceEnvStore,
  type WorkspaceEnv,
} from "@/modules/workspace";
import { Refresh01Icon, ServerStack03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect } from "react";

type Props = {
  onSelect: (env: WorkspaceEnv) => void;
};

/** Hook-free wrapper so non-Windows never subscribes to the workspace env store. */
export function WorkspaceEnvSelector({ onSelect }: Props) {
  if (!IS_WINDOWS) return <WorkspaceEnvSelectorHosts onSelect={onSelect} />;
  return <WorkspaceEnvSelectorWindows onSelect={onSelect} />;
}

/** Non-Windows (and fallback): current env label plus SSH host jumps. */
function WorkspaceEnvSelectorHosts({ onSelect }: Props) {
  const env = useWorkspaceEnvStore((s) => s.env);
  const hosts = useHostStore((s) => s.hosts);
  useEffect(() => {
    if (hosts.length === 0) void refreshHosts();
  }, [hosts.length]);
  const label =
    env.kind === "wsl"
      ? `WSL: ${env.distro}`
      : env.kind === "ssh"
        ? `SSH: ${env.hostId}`
        : "Local";
  if (hosts.length === 0) {
    return (
      <span
        title="Workspace environment"
        className="flex h-6 shrink-0 items-center gap-1 px-1.5 text-[11px] text-muted-foreground"
      >
        <HugeiconsIcon icon={ServerStack03Icon} size={13} strokeWidth={1.75} />
        <span className="max-w-28 truncate">{label}</span>
      </span>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-6 shrink-0 items-center gap-1 rounded-sm px-1.5 text-[11px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus:outline-none focus-visible:outline-none focus-visible:ring-0 data-[state=open]:bg-accent data-[state=open]:text-foreground"
          title="Workspace environment"
        >
          <HugeiconsIcon icon={ServerStack03Icon} size={13} strokeWidth={1.75} />
          <span className="max-w-28 truncate">{label}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-48">
        {hosts.map((h) => (
          <DropdownMenuItem
            key={h.id}
            onSelect={() => onSelect({ kind: "ssh", hostId: h.id })}
          >
            SSH: {h.alias}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WorkspaceEnvSelectorWindows({ onSelect }: Props) {
  const env = useWorkspaceEnvStore((s) => s.env);
  const distros = useWorkspaceEnvStore((s) => s.distros);
  const loading = useWorkspaceEnvStore((s) => s.loading);
  const error = useWorkspaceEnvStore((s) => s.error);
  const refreshDistros = useWorkspaceEnvStore((s) => s.refreshDistros);
  const hosts = useHostStore((s) => s.hosts);

  const handleOpenChange = (open: boolean) => {
    if (open && distros.length === 0 && !loading) {
      void refreshDistros();
    }
    if (open && hosts.length === 0) {
      void refreshHosts();
    }
  };

  const label =
    env.kind === "wsl"
      ? `WSL: ${env.distro}`
      : env.kind === "ssh"
        ? `SSH: ${env.hostId}`
        : "Windows";

  return (
    <DropdownMenu onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-6 shrink-0 items-center gap-1 rounded-sm px-1.5 text-[11px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus:outline-none focus-visible:outline-none focus-visible:ring-0 data-[state=open]:bg-accent data-[state=open]:text-foreground"
          title="Workspace environment"
        >
          <HugeiconsIcon
            icon={ServerStack03Icon}
            size={13}
            strokeWidth={1.75}
          />
          <span className="max-w-28 truncate">{label}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-48">
        <DropdownMenuItem onSelect={() => onSelect(LOCAL_WORKSPACE)}>
          Windows Local
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {distros.length === 0 ? (
          <DropdownMenuItem disabled>
            {loading
              ? "Loading WSL distros..."
              : error
                ? "WSL unavailable"
                : "No WSL distros found"}
          </DropdownMenuItem>
        ) : (
          distros.map((distro) => (
            <DropdownMenuItem
              key={distro.name}
              onSelect={() => onSelect({ kind: "wsl", distro: distro.name })}
            >
              WSL: {distro.name}
            </DropdownMenuItem>
          ))
        )}
        {hosts.length > 0 && (
          <>
            <DropdownMenuSeparator />
            {hosts.map((h) => (
              <DropdownMenuItem
                key={h.id}
                onSelect={() => onSelect({ kind: "ssh", hostId: h.id })}
              >
                SSH: {h.alias}
              </DropdownMenuItem>
            ))}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void refreshDistros()}>
          <HugeiconsIcon icon={Refresh01Icon} size={13} strokeWidth={1.75} />
          Refresh
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
