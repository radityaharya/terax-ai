import { cn } from "@/lib/utils";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import {
  Delete02Icon,
  PencilEdit02Icon,
  PlusSignIcon,
  Refresh01Icon,
  ServerStack03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState } from "react";
import {
  deleteHost,
  probeHost,
  refreshHosts,
  refreshImported,
  useHostStore,
  type ConnectionStatus,
} from "./lib/hostStore";
import type { ImportedHost, SshHost } from "./lib/types";

type Props = {
  onConnect: (host: SshHost) => void;
  onEdit: (host: SshHost | null) => void;
  onShowHostKey: (host: SshHost) => void;
  onShowAuth: (host: SshHost, next: string, message: string) => void;
};

function statusDot(status: ConnectionStatus | undefined): {
  className: string;
  label: string;
} {
  switch (status?.state) {
    case "online":
      return { className: "bg-emerald-500", label: "Connected" };
    case "checking":
      return { className: "bg-amber-400 animate-pulse", label: "Checking" };
    case "needs-auth":
    case "host-key":
      return { className: "bg-amber-400", label: "Needs attention" };
    case "offline":
      return { className: "bg-destructive", label: "Offline" };
    default:
      return { className: "bg-muted-foreground/40", label: "Unknown" };
  }
}

export function HostsPanel({ onConnect, onEdit, onShowHostKey, onShowAuth }: Props) {
  const hosts = useHostStore((s) => s.hosts);
  const imported = useHostStore((s) => s.imported);
  const importedLoaded = useHostStore((s) => s.importedLoaded);
  const loading = useHostStore((s) => s.loading);
  const error = useHostStore((s) => s.error);
  const connections = useHostStore((s) => s.connections);
  const env = useWorkspaceEnvStore((s) => s.env);
  const [filter, setFilter] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    void refreshHosts();
    void refreshImported();
  }, []);

  const activeHostId = env.kind === "ssh" ? env.hostId : null;

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return hosts;
    return hosts.filter(
      (h) =>
        h.alias.toLowerCase().includes(q) ||
        h.hostname.toLowerCase().includes(q) ||
        h.user.toLowerCase().includes(q),
    );
  }, [hosts, filter]);

  const unimported = useMemo(
    () => imported.filter((i) => !hosts.some((h) => h.alias === i.alias)),
    [imported, hosts],
  );

  const handleRowClick = async (host: SshHost) => {
    const existing = connections[host.id];
    if (existing?.state === "online") {
      onConnect(host);
      return;
    }
    const status = await probeHost(host);
    if (status.state === "online") onConnect(host);
    else if (status.state === "host-key") onShowHostKey(host);
    else if (status.state === "needs-auth")
      onShowAuth(host, status.next, status.message);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        title="Hosts"
        onAdd={() => onEdit(null)}
        onRefresh={() => {
          void refreshHosts();
          void refreshImported();
        }}
      />
      <div className="shrink-0 px-2 pb-1.5">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter hosts"
          className="h-7 w-full rounded-md border border-border/60 bg-background px-2 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-primary/50"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {loading && hosts.length === 0 ? (
          <EmptyNote text="Loading hosts..." />
        ) : error && hosts.length === 0 ? (
          <EmptyNote text={error} />
        ) : filtered.length === 0 && !filter ? (
          <EmptyNote text="No SSH hosts yet. Add one to get started." />
        ) : filtered.length === 0 ? (
          <EmptyNote text="No hosts match the filter." />
        ) : (
          filtered.map((host) => (
            <HostRow
              key={host.id}
              host={host}
              status={connections[host.id]}
              active={host.id === activeHostId}
              confirmingDelete={confirmDelete === host.id}
              onClick={() => void handleRowClick(host)}
              onEdit={() => onEdit(host)}
              onDelete={() => setConfirmDelete(host.id)}
              onConfirmDelete={() => {
                setConfirmDelete(null);
                void deleteHost(host.id);
              }}
              onCancelDelete={() => setConfirmDelete(null)}
            />
          ))
        )}
        {importedLoaded && unimported.length > 0 && (
          <ImportedSection hosts={unimported} onImport={() => void refreshHosts()} />
        )}
      </div>
    </div>
  );
}

function PanelHeader({
  title,
  onAdd,
  onRefresh,
}: {
  title: string;
  onAdd: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between px-2.5 pb-1.5 pt-2">
      <span className="text-xs font-semibold text-foreground">{title}</span>
      <div className="flex items-center gap-0.5">
        <HeaderButton label="Refresh hosts" onClick={onRefresh}>
          <HugeiconsIcon icon={Refresh01Icon} size={13} strokeWidth={1.75} />
        </HeaderButton>
        <HeaderButton label="Add host" onClick={onAdd}>
          <HugeiconsIcon icon={PlusSignIcon} size={14} strokeWidth={1.75} />
        </HeaderButton>
      </div>
    </div>
  );
}

function HeaderButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-6 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  );
}

function EmptyNote({ text }: { text: string }) {
  return (
    <div className="px-2 py-6 text-center text-[11px] text-muted-foreground/70">
      {text}
    </div>
  );
}

function HostRow({
  host,
  status,
  active,
  confirmingDelete,
  onClick,
  onEdit,
  onDelete,
  onConfirmDelete,
  onCancelDelete,
}: {
  host: SshHost;
  status: ConnectionStatus | undefined;
  active: boolean;
  confirmingDelete: boolean;
  onClick: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}) {
  const dot = statusDot(status);
  const target = `${host.user}@${host.hostname}${host.port === 22 ? "" : `:${host.port}`}`;
  const detail =
    status?.state === "online"
      ? status.home
      : status?.state === "offline" || status?.state === "needs-auth"
        ? status.message
        : target;
  return (
    // biome-ignore lint/a11y/useSemanticElements: row hosts nested buttons, cannot be a <button>
    <div
      role="button"
      tabIndex={0}
      title={`Connect to ${host.alias}`}
      onClick={confirmingDelete ? undefined : onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !confirmingDelete) {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        "group relative flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/40",
        active ? "bg-accent" : "hover:bg-accent/50",
      )}
    >
      <span
        role="img"
        aria-label={dot.label}
        title={dot.label}
        className={cn("size-2 shrink-0 rounded-full", dot.className)}
      />
      <HugeiconsIcon
        icon={ServerStack03Icon}
        size={14}
        strokeWidth={1.75}
        className="shrink-0 text-muted-foreground/70"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[12px] font-medium leading-tight">
          {host.alias}
        </span>
        <span className="truncate text-[10px] leading-tight text-muted-foreground/60">
          {confirmingDelete ? "Delete this host?" : detail}
        </span>
      </span>
      {confirmingDelete ? (
        <span className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onConfirmDelete();
            }}
            className="rounded px-1.5 py-0.5 text-[10px] font-medium text-destructive hover:bg-destructive/10"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onCancelDelete();
            }}
            className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent"
          >
            Keep
          </button>
        </span>
      ) : (
        <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
          <RowButton label="Edit host" onClick={onEdit}>
            <HugeiconsIcon icon={PencilEdit02Icon} size={13} strokeWidth={1.75} />
          </RowButton>
          <RowButton label="Delete host" onClick={onDelete}>
            <HugeiconsIcon icon={Delete02Icon} size={13} strokeWidth={1.75} />
          </RowButton>
        </span>
      )}
    </div>
  );
}

function RowButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="flex size-5 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  );
}

function ImportedSection({
  hosts,
  onImport,
}: {
  hosts: ImportedHost[];
  onImport: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="mt-2 border-t border-border/60 pt-1.5">
      <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">
        From ~/.ssh/config
      </div>
      {hosts.map((h) => (
        <button
          key={h.alias}
          type="button"
          disabled={busy !== null}
          onClick={() => {
            setBusy(h.alias);
            importOne(h.alias).finally(() => {
              setBusy(null);
              onImport();
            });
          }}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/50 disabled:opacity-50"
        >
          <HugeiconsIcon
            icon={ServerStack03Icon}
            size={13}
            strokeWidth={1.75}
            className="shrink-0 text-muted-foreground/60"
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12px]">{h.alias}</span>
            <span className="block truncate text-[10px] text-muted-foreground/60">
              {busy === h.alias ? "Importing..." : targetOf(h)}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

function targetOf(h: ImportedHost): string {
  const user = h.user ? `${h.user}@` : "";
  const host = h.hostname ?? h.alias;
  const port = h.port && h.port !== 22 ? `:${h.port}` : "";
  return `${user}${host}${port}`;
}

async function importOne(alias: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("ssh_import_host", { alias, user: null });
}
