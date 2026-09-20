import { cn } from "@/lib/utils";
import { Cancel01Icon, CopyIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import {
  type InspectState,
  inspectKey,
  useDockerStore,
} from "../lib/dockerStore";

export type InspectTarget = {
  kind: "container" | "image" | "volume" | "network" | "service";
  id: string;
  title: string;
} | null;

type Props = {
  hostId: string;
  target: InspectTarget;
  onClose: () => void;
  /** Render body only (no frame): the SidebarDeck owns header + close. */
  bare?: boolean;
};

/** Slide-over showing structured `docker inspect` output. */
export function DetailsDrawer({ hostId, target, onClose, bare }: Props) {
  const key = target
    ? `${hostId}\u0000${inspectKey(target.kind, target.id)}`
    : null;
  const state: InspectState = useDockerStore((s) =>
    key ? (s.inspects[key] ?? { status: "idle" }) : { status: "idle" },
  );
  const fetchInspect = useDockerStore((s) => s.fetchInspect);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (target) {
      setCopied(false);
      void fetchInspect(hostId, target.kind, target.id);
    }
  }, [hostId, target, fetchInspect]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!target) return null;

  const copyJson = async () => {
    if (state.status !== "ready") return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(state.data, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard unavailable — ignore
    }
  };

  if (bare) {
    return (
      <div className="flex min-h-0 flex-1 flex-col px-2.5 py-2">
        {state.status === "ready" ? (
          <InspectBody data={state.data} />
        ) : state.status === "loading" || state.status === "idle" ? (
          <div className="py-6 text-center text-[11px] text-muted-foreground/70">
            Loading inspect…
          </div>
        ) : (
          <div className="break-words py-6 text-center text-[11px] text-destructive">
            {state.message}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="absolute inset-y-0 right-0 z-20 flex w-80 max-w-[85%] flex-col border-l border-border/60 bg-background shadow-xl"
      role="dialog"
      aria-label={`${target.kind} details: ${target.title}`}
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-2.5 py-2">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
          {target.title}
        </span>
        <span className="shrink-0 rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          {target.kind}
        </span>
        {state.status === "ready" ? (
          <button
            type="button"
            onClick={() => void copyJson()}
            title={copied ? "Copied" : "Copy JSON"}
            className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
          >
            <HugeiconsIcon icon={CopyIcon} size={13} strokeWidth={1.75} />
          </button>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          title="Close details"
          aria-label="Close details"
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={13} strokeWidth={1.75} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
        {state.status === "ready" ? (
          <InspectBody data={state.data} />
        ) : state.status === "loading" || state.status === "idle" ? (
          <div className="py-6 text-center text-[11px] text-muted-foreground/70">
            Loading inspect…
          </div>
        ) : (
          <div className="break-words py-6 text-center text-[11px] text-destructive">
            {state.message}
          </div>
        )}
      </div>
    </div>
  );
}

function InspectBody({ data }: { data: unknown }) {
  const first = Array.isArray(data) ? data[0] : data;
  if (!first || typeof first !== "object") {
    return <RawJson data={data} />;
  }
  const rec = first as Record<string, unknown>;
  const chips = topChips(rec);
  return (
    <div className="flex flex-col gap-2">
      {chips.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {chips.map((c) => (
            <span
              key={c.label}
              title={c.title ?? c.label}
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-medium",
                c.tone === "good" &&
                  "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
                c.tone === "warn" &&
                  "bg-amber-500/15 text-amber-600 dark:text-amber-400",
                c.tone === "bad" && "bg-destructive/10 text-destructive",
                c.tone === "muted" && "bg-accent text-muted-foreground",
              )}
            >
              {c.label}
            </span>
          ))}
        </div>
      ) : null}
      <KV label="Id" value={shortId(rec.Id)} mono />
      <KV
        label="Image"
        value={str(nested(rec, ["Config", "Image"]) ?? rec.Image)}
        mono
      />
      <KV label="Command" value={cmdline(rec)} mono wrap />
      <KV label="Created" value={str(rec.Created)} />
      <KV
        label="RestartPolicy"
        value={str(nested(rec, ["HostConfig", "RestartPolicy", "Name"]))}
      />
      <KV label="ExitCode" value={num(nested(rec, ["State", "ExitCode"]))} />
      <KV
        label="OOMKilled"
        value={boolStr(nested(rec, ["State", "OOMKilled"]))}
      />
      <KV label="Error" value={str(nested(rec, ["State", "Error"]))} wrap />
      <KV
        label="Health"
        value={str(nested(rec, ["State", "Health", "Status"]))}
      />
      <KV label="Mounts" value={mounts(rec)} wrap />
      <KV label="Ports" value={ports(rec)} wrap />
      <KV label="Env" value={envList(rec)} wrap mono />
      <details className="mt-1">
        <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">
          Raw JSON
        </summary>
        <RawJson data={data} />
      </details>
    </div>
  );
}

type Chip = {
  label: string;
  tone: "good" | "warn" | "bad" | "muted";
  title?: string;
};

function topChips(rec: Record<string, unknown>): Chip[] {
  const chips: Chip[] = [];
  const running = nested(rec, ["State", "Running"]) === true;
  const status = str(nested(rec, ["State", "Status"]));
  if (running) chips.push({ label: "running", tone: "good", title: status });
  else if (status) chips.push({ label: status, tone: "muted", title: status });
  const health = str(nested(rec, ["State", "Health", "Status"]));
  if (health) {
    chips.push({
      label: `health: ${health}`,
      tone:
        health === "healthy" ? "good" : health === "unhealthy" ? "bad" : "warn",
    });
  }
  const restart = str(nested(rec, ["HostConfig", "RestartPolicy", "Name"]));
  if (restart && restart !== "no" && restart !== "") {
    chips.push({ label: `restart: ${restart}`, tone: "muted" });
  }
  const exit = nested(rec, ["State", "ExitCode"]);
  if (!running && typeof exit === "number") {
    chips.push({
      label: `exit ${exit}`,
      tone: exit === 0 ? "muted" : "bad",
    });
  }
  if (nested(rec, ["State", "OOMKilled"]) === true)
    chips.push({ label: "OOMKilled", tone: "bad" });
  return chips;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Safely walk a record path; returns undefined when any hop is missing. */
function nested(rec: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = rec;
  for (const key of path) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function num(v: unknown): string {
  return typeof v === "number" ? String(v) : "";
}

function boolStr(v: unknown): string {
  return typeof v === "boolean" ? String(v) : "";
}

function shortId(v: unknown): string {
  const s = str(v).replace(/^sha256:/, "");
  return s ? s.slice(0, 12) : "";
}

function cmdline(rec: Record<string, unknown>): string {
  const cfg = nested(rec, ["Config"]);
  const cfgRec =
    cfg && typeof cfg === "object" && !Array.isArray(cfg)
      ? (cfg as Record<string, unknown>)
      : undefined;
  const parts = [...arrayStr(cfgRec?.Entrypoint), ...arrayStr(cfgRec?.Cmd)];
  return parts.join(" ");
}

function arrayStr(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : [];
}

function mounts(rec: Record<string, unknown>): string {
  const mounts = rec.Mounts;
  if (!Array.isArray(mounts)) return "";
  return mounts
    .map((m) => {
      const r = m as Record<string, unknown>;
      return `${str(r.Source)} → ${str(r.Destination)}${r.RW === false ? " (ro)" : ""}`;
    })
    .join("\n");
}

function ports(rec: Record<string, unknown>): string {
  const ports = (rec.NetworkSettings as Record<string, unknown> | undefined)
    ?.Ports as Record<string, unknown> | undefined;
  if (!ports) return "";
  const out: string[] = [];
  for (const [container, bindings] of Object.entries(ports)) {
    if (!Array.isArray(bindings)) {
      out.push(container);
      continue;
    }
    for (const b of bindings) {
      const r = b as Record<string, unknown>;
      out.push(`${str(r.HostIp)}:${str(r.HostPort)} → ${container}`);
    }
  }
  return out.join("\n");
}

function envList(rec: Record<string, unknown>): string {
  const env = nested(rec, ["Config", "Env"]);
  if (!Array.isArray(env)) return "";
  // Redact likely secrets server-side values never echo back here, but the
  // daemon may still embed them — mask common secret-looking vars.
  return env
    .filter((x): x is string => typeof x === "string")
    .map((e) => {
      const [k, ...rest] = e.split("=");
      if (/pass|secret|token|key/i.test(k)) return `${k}=••••••`;
      return e.startsWith("=") ? e : `${k}=${rest.join("=")}`;
    })
    .join("\n");
}

function KV({
  label,
  value,
  mono,
  wrap,
}: {
  label: string;
  value: string;
  mono?: boolean;
  wrap?: boolean;
}) {
  if (!value) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
        {label}
      </span>
      <span
        className={cn(
          "text-[11px] text-foreground/90",
          mono && "font-mono",
          wrap ? "whitespace-pre-wrap break-all" : "truncate",
        )}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function RawJson({ data }: { data: unknown }) {
  return (
    <pre className="mt-1 overflow-x-auto rounded bg-accent/50 p-2 font-mono text-[10px] leading-relaxed text-foreground/80">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}
