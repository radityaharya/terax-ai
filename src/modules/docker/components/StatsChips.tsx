import { cn } from "@/lib/utils";
import {
  CellularNetworkIcon,
  CpuIcon,
  HardDriveIcon,
  RamMemoryIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { StatsSample } from "../lib/dockerStore";
import {
  compactIO,
  compactUsage,
  cpuTone,
  memTone,
  type StatTone,
} from "../lib/stats";

function StatChip({
  label,
  icon,
  value,
  unit,
  tone,
  title,
}: {
  label: string;
  icon: React.ReactNode;
  value: string;
  unit?: string;
  tone: StatTone;
  title: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex cursor-default items-center gap-1 rounded bg-accent/60 px-1 py-px",
        tone === "ok" && "text-emerald-500",
        tone === "warn" && "text-amber-500",
        tone === "hot" && "text-destructive",
        tone === "muted" && "text-muted-foreground/80",
      )}
    >
      <span className="flex items-center gap-0.5 opacity-70">
        {icon}
        <span className="font-medium">{label}</span>
      </span>
      <span className="font-medium tabular-nums">
        {value || "—"}
        {unit ? <span className="ml-px font-normal opacity-60">{unit}</span> : null}
      </span>
    </span>
  );
}

/** Live stats footer for a container/service row. One shared component so
 *  every list shows CPU/MEM/NET/BLK identically. */
export function StatsChips({
  stats,
  className,
}: {
  stats: StatsSample;
  className?: string;
}) {
  if (
    ![stats.cpuPerc, stats.memUsage, stats.memPerc, stats.netIO, stats.blockIO].some(
      (v) => typeof v === "string" && v.length > 0,
    )
  ) {
    return null;
  }
  const detail = `CPU ${stats.cpuPerc || "—"} · MEM ${stats.memUsage || "—"} (${stats.memPerc || "—"}) · NET ${stats.netIO || "—"} · BLK ${stats.blockIO || "—"} · PIDs ${stats.pids || "—"}`;
  return (
    <span
      className={cn(
        "mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] leading-tight",
        className,
      )}
    >
      <StatChip
        label="CPU"
        icon={<HugeiconsIcon icon={CpuIcon} size={10} strokeWidth={1.75} />}
        value={stats.cpuPerc.replace(/%$/, "")}
        unit="%"
        tone={cpuTone(stats.cpuPerc)}
        title={detail}
      />
      <StatChip
        label="MEM"
        icon={<HugeiconsIcon icon={RamMemoryIcon} size={10} strokeWidth={1.75} />}
        value={`${compactUsage(stats.memUsage)}${stats.memPerc ? ` ${stats.memPerc}` : ""}`}
        tone={memTone(stats.memPerc)}
        title={detail}
      />
      <StatChip
        label="NET"
        icon={
          <HugeiconsIcon icon={CellularNetworkIcon} size={10} strokeWidth={1.75} />
        }
        value={compactIO(stats.netIO)}
        tone="muted"
        title={detail}
      />
      <StatChip
        label="BLK"
        icon={<HugeiconsIcon icon={HardDriveIcon} size={10} strokeWidth={1.75} />}
        value={compactIO(stats.blockIO)}
        tone="muted"
        title={detail}
      />
    </span>
  );
}
