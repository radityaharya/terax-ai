import { fuzzyBest } from "@/modules/command-palette/lib/fuzzy";
import { mruRank } from "@/modules/command-palette/lib/mru";

/**
 * One launchable entry in the New Tab menu. Kept free of React so the ranking
 * and address parsing can be tested without rendering the popover.
 */
export type NewTabProfile = {
  /** Stable MRU key, namespaced so it can't collide with palette commands. */
  id: string;
  kind: "tab" | "ssh" | "docker" | "zellij" | "quick";
  title: string;
  /** Secondary line / right-hand text (host target, shortcut, …). */
  detail?: string;
  /** Extra search terms that aren't shown. */
  keywords?: string[];
  run: () => void;
};

/** Prefix for every New Tab menu entry in the shared MRU store. */
export const NEW_TAB_MRU_PREFIX = "newtab:";

export const NEW_TAB_GROUPS = [
  "Connect",
  "Tabs",
  "SSH hosts",
  "Docker exec",
  "Zellij sessions",
] as const;

export function groupForKind(kind: NewTabProfile["kind"]): string {
  switch (kind) {
    case "quick":
      return "Connect";
    case "ssh":
      return "SSH hosts";
    case "docker":
      return "Docker exec";
    case "zellij":
      return "Zellij sessions";
    default:
      return "Tabs";
  }
}

export type QuickConnect = { user: string; host: string; port: number | null };

/**
 * Parse an `user@host[:port]` typed into the search box.
 *
 * The `user@` part is required on purpose: a bare hostname (or a stray
 * substring of one) is ambiguous, and quick connect has to invent a login
 * name for it. Users with a saved host get a real profile row instead.
 */
export function parseQuickConnect(query: string): QuickConnect | null {
  const match = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+?)(?::(\d{1,5}))?$/.exec(
    query.trim(),
  );
  if (!match) return null;
  const port = match[3] ? Number.parseInt(match[3], 10) : null;
  if (port !== null && (port < 1 || port > 65535)) return null;
  if (!match[2].includes(".") && match[2] !== "localhost") return null;
  return { user: match[1], host: match[2], port };
}

export function quickConnectId(connect: QuickConnect): string {
  return `${NEW_TAB_MRU_PREFIX}quick:${connect.user}@${connect.host}:${connect.port ?? 22}`;
}

/**
 * Fuzzy-rank profiles for a typed term. An empty term is a no-op ordering
 * (the caller renders groups in their declared order instead of scramming
 * them by recency), so this only runs once the user types.
 */
export function rankProfiles(
  profiles: NewTabProfile[],
  term: string,
  mru: Record<string, number>,
): NewTabProfile[] {
  const query = term.trim().toLowerCase();
  if (!query) return profiles;

  const scored: { profile: NewTabProfile; score: number }[] = [];
  for (const profile of profiles) {
    const score = fuzzyBest(
      query,
      [profile.title, profile.detail ?? "", ...(profile.keywords ?? [])].filter(
        Boolean,
      ) as string[],
    );
    if (score !== null) scored.push({ profile, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      mruRank(mru, b.profile.id) - mruRank(mru, a.profile.id),
  );
  return scored.map((entry) => entry.profile);
}

/**
 * Most-recently-launched profiles, newest first. Only ids this prefix owns,
 * so the menu never surfaces a command-palette entry as a "recent profile".
 */
export function recentProfiles(
  profiles: NewTabProfile[],
  mru: Record<string, number>,
  limit = 5,
): NewTabProfile[] {
  return profiles
    .map((profile) => ({ profile, rank: mruRank(mru, profile.id) }))
    .filter((entry) => entry.rank > 0)
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit)
    .map((entry) => entry.profile);
}

/** Group ranked profiles in the declared group order, dropping empties. */
export function groupProfiles(
  profiles: NewTabProfile[],
): { group: string; profiles: NewTabProfile[] }[] {
  return NEW_TAB_GROUPS.map((group) => ({
    group,
    profiles: profiles.filter((p) => groupForKind(p.kind) === group),
  })).filter((entry) => entry.profiles.length > 0);
}
