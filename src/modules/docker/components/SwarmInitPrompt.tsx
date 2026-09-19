import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { useDockerStore } from "../lib/dockerStore";

type Props = {
  hostId: string;
  onClose: () => void;
};

/** Swarm init / join / leave flows. Join tokens are never stored. */
export function SwarmInitPrompt({ hostId, onClose }: Props) {
  const swarmInit = useDockerStore((s) => s.swarmInit);
  const swarmJoin = useDockerStore((s) => s.swarmJoin);
  const swarmLeave = useDockerStore((s) => s.swarmLeave);
  const error = useDockerStore((s) => s.byHost[hostId]?.swarm.error ?? null);
  const [mode, setMode] = useState<"init" | "join" | "leave">("init");
  const [advertiseAddr, setAdvertiseAddr] = useState("");
  const [token, setToken] = useState("");
  const [addr, setAddr] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = () => {
    if (mode === "init") void swarmInit(hostId, advertiseAddr.trim() || undefined).then(onClose);
    else if (mode === "join" && token.trim() && addr.trim()) {
      void swarmJoin(hostId, token.trim(), addr.trim()).then(() => {
        setToken("");
        onClose();
      });
    } else if (mode === "leave" && confirmLeave) {
      void swarmLeave(hostId, true).then(onClose);
    }
  };

  return (
    <div
      className="absolute inset-y-0 right-0 z-20 flex w-80 max-w-[85%] flex-col border-l border-border/60 bg-background shadow-xl"
      role="dialog"
      aria-label="Initialize or join swarm"
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-2.5 py-2">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
          Swarm setup
        </span>
        <button
          type="button"
          onClick={onClose}
          title="Close swarm setup"
          aria-label="Close swarm setup"
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={13} strokeWidth={1.75} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2.5 py-2">
        <div className="flex gap-1">
          {(["init", "join", "leave"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
              className={
                mode === m
                  ? "rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-foreground"
                  : "rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
              }
            >
              {m === "init" ? "Init" : m === "join" ? "Join" : "Leave"}
            </button>
          ))}
        </div>
        {mode === "init" ? (
          <label className="flex flex-col gap-1 text-[11px]">
            <span className="font-medium text-muted-foreground">Advertise address (optional)</span>
            <input
              value={advertiseAddr}
              onChange={(e) => setAdvertiseAddr(e.target.value)}
              placeholder="192.168.1.10"
              className="h-7 rounded-md border border-border/60 bg-background px-2 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-primary/50"
            />
          </label>
        ) : null}
        {mode === "join" ? (
          <>
            <label className="flex flex-col gap-1 text-[11px]">
              <span className="font-medium text-muted-foreground">Join token</span>
              <input
                type={showToken ? "text" : "password"}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
                className="h-7 rounded-md border border-border/60 bg-background px-2 font-mono text-xs outline-none placeholder:text-muted-foreground/60 focus:border-primary/50"
              />
            </label>
            <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <input type="checkbox" checked={showToken} onChange={(e) => setShowToken(e.target.checked)} />
              Show token
            </label>
            <label className="flex flex-col gap-1 text-[11px]">
              <span className="font-medium text-muted-foreground">Manager address</span>
              <input
                value={addr}
                onChange={(e) => setAddr(e.target.value)}
                placeholder="192.168.1.10:2377"
                className="h-7 rounded-md border border-border/60 bg-background px-2 font-mono text-xs outline-none placeholder:text-muted-foreground/60 focus:border-primary/50"
              />
            </label>
            <div className="text-[10px] text-muted-foreground/70">
              The token is sent straight into `docker swarm join` and never stored.
            </div>
          </>
        ) : null}
        {mode === "leave" ? (
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <input type="checkbox" checked={confirmLeave} onChange={(e) => setConfirmLeave(e.target.checked)} />
            Force leave (also on last manager)
          </label>
        ) : null}
        {error ? <div className="break-words text-[11px] text-destructive">{error}</div> : null}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-1.5 border-t border-border/60 px-2.5 py-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={
            (mode === "join" && (!token.trim() || !addr.trim())) ||
            (mode === "leave" && !confirmLeave)
          }
          className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {mode === "init" ? "Initialize swarm" : mode === "join" ? "Join swarm" : "Leave swarm"}
        </button>
      </div>
    </div>
  );
}
