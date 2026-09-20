import { sshRpc } from "@/modules/ai/lib/native";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";

type Props = {
  hostId: string;
  container: string;
  containerName: string;
  onExec: (shell: string, attach: boolean) => void;
  onClose: () => void;
  /** Render body only (no frame): the deck panel owns header + close. */
  bare?: boolean;
};

const SHELLS = ["sh", "bash", "ash", "zsh", "fish"];

/** Pick a shell (probed in the container) or attach, then open an exec tab. */
export function ExecDialog({
  hostId,
  container,
  containerName,
  onExec,
  onClose,
  bare,
}: Props) {
  const [shell, setShell] = useState("sh");
  const [probing, setProbing] = useState(true);
  const [attach, setAttach] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setProbing(true);
    sshRpc<{ shell: string | null }>(
      "docker_container_shell_probe",
      { id: container },
      hostId,
    )
      .then((res) => {
        if (cancelled) return;
        if (res.shell && SHELLS.includes(res.shell)) setShell(res.shell);
        setProbing(false);
      })
      .catch(() => {
        if (!cancelled) setProbing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hostId, container]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Enter") onExec(shell, attach);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onExec, shell, attach]);

  if (bare) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col gap-2 px-2.5 py-2">
          <ExecBody />
        </div>
        <ExecActions />
      </div>
    );
  }

  return (
    <div
      className="absolute inset-y-0 right-0 z-20 flex w-80 max-w-[85%] flex-col border-l border-border/60 bg-background shadow-xl"
      role="dialog"
      aria-label={`Exec shell in ${containerName}`}
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-2.5 py-2">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
          Exec in {containerName}
        </span>
        <button
          type="button"
          onClick={onClose}
          title="Close exec"
          aria-label="Close exec"
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={13} strokeWidth={1.75} />
        </button>
      </div>
      <ExecBody />
      <ExecActions />
    </div>
  );

  function ExecBody() {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2.5 py-2">
        <label className="flex flex-col gap-1 text-[11px]">
          <span className="font-medium text-muted-foreground">Shell</span>
          <select
            value={shell}
            onChange={(e) => setShell(e.target.value)}
            disabled={attach}
            className="h-7 rounded-md border border-border/60 bg-background px-2 text-xs outline-none focus:border-primary/50 disabled:opacity-50"
          >
            {SHELLS.map((s) => (
              <option key={s} value={s}>
                {s}
                {probing ? "" : s === shell ? " (detected)" : ""}
              </option>
            ))}
          </select>
        </label>
        {probing ? (
          <div className="text-[10px] text-muted-foreground/70">
            Probing shells in the container…
          </div>
        ) : null}
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            checked={attach}
            onChange={(e) => setAttach(e.target.checked)}
          />
          Attach to main process instead of exec
        </label>
        <div className="text-[10px] text-muted-foreground/70">
          Opens a terminal tab running `docker exec -it {container}{" "}
          {attach ? "" : shell}` on this host. The tab reconnects from the
          Docker panel if the shell exits.
        </div>
      </div>
    );
  }

  function ExecActions() {
    return (
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
          onClick={() => onExec(shell, attach)}
          className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:opacity-90"
        >
          Open terminal
        </button>
      </div>
    );
  }
}
