import { Delete02Icon, Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { confirmDockerAction } from "../lib/dockerConfirmStore";
import { useDockerStore } from "../lib/dockerStore";

type Props = {
  hostId: string;
};

/** Swarm secrets + configs: list, create (values never stored), remove. */
export function SwarmSecretsPanel({ hostId }: Props) {
  const swarm = useDockerStore((s) => s.byHost[hostId]?.swarm);
  const refreshSwarmSecrets = useDockerStore((s) => s.refreshSwarmSecrets);
  const secretCreate = useDockerStore((s) => s.secretCreate);
  const secretRemove = useDockerStore((s) => s.secretRemove);
  const configCreate = useDockerStore((s) => s.configCreate);
  const configRemove = useDockerStore((s) => s.configRemove);
  const [tab, setTab] = useState<"secrets" | "configs">("secrets");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [file, setFile] = useState("");

  useEffect(() => {
    void refreshSwarmSecrets(hostId);
  }, [hostId, refreshSwarmSecrets]);

  const submit = () => {
    if (tab === "secrets") {
      if (!name.trim() || !value) return;
      void secretCreate(hostId, name.trim(), value).then(() => {
        setName("");
        setValue("");
      });
    } else {
      if (!name.trim() || !file.trim()) return;
      void configCreate(hostId, name.trim(), file.trim()).then(() => {
        setName("");
        setFile("");
      });
    }
  };

  const handleRemove = async (item: { id: string; name: string }) => {
    const isSecret = tab === "secrets";
    const confirmed = await confirmDockerAction({
      title: `Remove swarm ${isSecret ? "secret" : "config"}`,
      actionLabel: "Remove",
      actionVariant: "destructive",
      resourceKind: isSecret ? "Secret" : "Config",
      resourceName: item.name,
      resourceDetails: `ID: ${item.id}`,
      hostAlias: hostId,
      description: `Permanently deletes this ${isSecret ? "secret" : "config"} from the swarm manager. Services referencing it will fail if restarted.`,
    });
    if (!confirmed) return;
    if (isSecret) void secretRemove(hostId, item.name);
    else void configRemove(hostId, item.name);
  };

  const items =
    tab === "secrets"
      ? (swarm?.secrets ?? []).map((s) => ({ id: String(s.ID ?? s.Name ?? "?"), name: String(s.Name ?? "?") }))
      : (swarm?.configs ?? []).map((c) => ({ id: String(c.ID ?? c.Name ?? "?"), name: String(c.Name ?? "?") }));

  return (
    <div className="rounded-md border border-border/40 px-2 py-1.5">
      <div className="flex items-center gap-1">
        {(["secrets", "configs"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            aria-pressed={tab === t}
            className={
              tab === t
                ? "rounded-md bg-accent px-2 py-0.5 text-[11px] font-medium text-foreground"
                : "rounded-md px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
            }
          >
            {t === "secrets" ? "Secrets" : "Configs"}
          </button>
        ))}
        <button
          type="button"
          onClick={() => void refreshSwarmSecrets(hostId)}
          title="Refresh secrets and configs"
          className="ml-auto flex size-5 items-center justify-center rounded text-muted-foreground/70 hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={Refresh01Icon} size={12} strokeWidth={1.75} />
        </button>
      </div>
      {items.length === 0 ? (
        <div className="py-2 text-center text-[11px] text-muted-foreground/70">
          No {tab} on this swarm.
        </div>
      ) : (
        <div className="mt-1 flex flex-col gap-0.5">
          {items.map((item) => (
            <div key={item.id} className="group flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-accent/50">
              <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{item.name}</span>
              <button
                type="button"
                aria-label={`Remove ${tab === "secrets" ? "secret" : "config"} ${item.name}`}
                onClick={() => void handleRemove(item)}
                className="hidden size-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 hover:bg-accent hover:text-foreground group-hover:flex"
              >
                <HugeiconsIcon icon={Delete02Icon} size={12} strokeWidth={1.75} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="mt-1.5 flex flex-col gap-1 border-t border-border/40 pt-1.5">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={tab === "secrets" ? "Secret name" : "Config name"}
          className="h-6 rounded border border-border/60 bg-background px-1.5 font-mono text-[11px] outline-none placeholder:text-muted-foreground/60 focus:border-primary/50"
        />
        {tab === "secrets" ? (
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Secret value (never stored)"
            autoComplete="off"
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            className="h-6 rounded border border-border/60 bg-background px-1.5 font-mono text-[11px] outline-none placeholder:text-muted-foreground/60 focus:border-primary/50"
          />
        ) : (
          <input
            value={file}
            onChange={(e) => setFile(e.target.value)}
            placeholder="/path/on/host/to/file"
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            className="h-6 rounded border border-border/60 bg-background px-1.5 font-mono text-[11px] outline-none placeholder:text-muted-foreground/60 focus:border-primary/50"
          />
        )}
        <button
          type="button"
          onClick={submit}
          disabled={tab === "secrets" ? !name.trim() || !value : !name.trim() || !file.trim()}
          className="rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          Create {tab === "secrets" ? "secret" : "config"}
        </button>
        <div className="text-[10px] text-muted-foreground/70">
          {tab === "secrets"
            ? "Values pipe straight into `docker secret create` — never stored, never logged."
            : "The file must live under the agent's authorized root on the host."}
        </div>
      </div>
    </div>
  );
}
