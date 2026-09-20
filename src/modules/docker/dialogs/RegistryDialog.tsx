import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { useDockerStore } from "../lib/dockerStore";

type Props = {
  hostId: string;
  onClose: () => void;
  /** Render body only (no frame): the deck panel owns header + close. */
  bare?: boolean;
};

const COMMON = ["docker.io", "ghcr.io", "gcr.io", "quay.io"];

/** Registry login/logout. Credentials go to the keyring + login stdin —
 *  the store only ever holds login state. */
export function RegistryDialog({ hostId, onClose, bare }: Props) {
  const registries = useDockerStore((s) => s.byHost[hostId]?.registries ?? {});
  const registryLogin = useDockerStore((s) => s.registryLogin);
  const registryLogout = useDockerStore((s) => s.registryLogout);
  const [registry, setRegistry] = useState("docker.io");
  const [custom, setCustom] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const active = registry === "custom" ? custom.trim() : registry;
  const state = registries[active];
  const canSubmit =
    active.length > 0 &&
    username.trim().length > 0 &&
    password.length > 0 &&
    !state?.busy;

  const submit = () => {
    if (!canSubmit) return;
    void registryLogin(hostId, active, username.trim(), password).then(() =>
      setPassword(""),
    );
  };

  if (bare) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col gap-2 px-2.5 py-2">
          <RegistryBody />
        </div>
        <RegistryActions />
      </div>
    );
  }

  return (
    <div
      className="absolute inset-y-0 right-0 z-20 flex w-80 max-w-[85%] flex-col border-l border-border/60 bg-background shadow-xl"
      role="dialog"
      aria-label="Docker registry login"
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-2.5 py-2">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
          Registry login
        </span>
        <button
          type="button"
          onClick={onClose}
          title="Close registry login"
          aria-label="Close registry login"
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={13} strokeWidth={1.75} />
        </button>
      </div>
      <RegistryBody />
      <RegistryActions />
    </div>
  );

  function RegistryBody() {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2.5 py-2">
        <label className="flex flex-col gap-1 text-[11px]">
          <span className="font-medium text-muted-foreground">Registry</span>
          <select
            value={registry}
            onChange={(e) => setRegistry(e.target.value)}
            className="h-7 rounded-md border border-border/60 bg-background px-2 text-xs outline-none focus:border-primary/50"
          >
            {COMMON.map((r) => (
              <option key={r} value={r}>
                {r}
                {registries[r]?.loggedIn ? " (logged in)" : ""}
              </option>
            ))}
            <option value="custom">Custom…</option>
          </select>
        </label>
        {registry === "custom" ? (
          <label className="flex flex-col gap-1 text-[11px]">
            <span className="font-medium text-muted-foreground">
              Custom registry host
            </span>
            <input
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="registry.example.com:5000"
              className="h-7 rounded-md border border-border/60 bg-background px-2 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-primary/50"
            />
          </label>
        ) : null}
        <label className="flex flex-col gap-1 text-[11px]">
          <span className="font-medium text-muted-foreground">Username</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            className="h-7 rounded-md border border-border/60 bg-background px-2 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-primary/50"
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px]">
          <span className="font-medium text-muted-foreground">
            Password / token
          </span>
          <input
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            className="h-7 rounded-md border border-border/60 bg-background px-2 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-primary/50"
          />
        </label>
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            checked={showPassword}
            onChange={(e) => setShowPassword(e.target.checked)}
          />
          Show password
        </label>
        {state?.error ? (
          <div className="break-words text-[11px] text-destructive">
            {state.error}
          </div>
        ) : null}
        {state?.loggedIn ? (
          <div className="text-[11px] text-emerald-600 dark:text-emerald-400">
            Logged in to {active}.
          </div>
        ) : null}
        <div className="text-[10px] text-muted-foreground/70">
          The password is sent over the authenticated agent channel straight
          into `docker login --password-stdin`, then kept in your OS keyring —
          never in Terax state or logs.
        </div>
      </div>
    );
  }

  function RegistryActions() {
    return (
      <div className="flex shrink-0 items-center justify-end gap-1.5 border-t border-border/60 px-2.5 py-2">
        {state?.loggedIn ? (
          <button
            type="button"
            disabled={state?.busy}
            onClick={() => void registryLogout(hostId, active)}
            className="rounded-md border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            Log out
          </button>
        ) : null}
        <button
          type="button"
          disabled={!canSubmit}
          onClick={submit}
          className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {state?.busy ? "Logging in…" : "Log in"}
        </button>
      </div>
    );
  }
}
