import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { fmtShortcut, MOD_KEY, SHIFT_KEY } from "@/lib/platform";
import { AgentLauncherPanel } from "@/modules/agents/components/AgentLauncherPanel";
import type { AgentLaunchRequest } from "@/modules/agents/lib/launcher";
import { refreshHosts, saveHost, useHostStore, type SshHost } from "@/modules/hosts";
import { clearMruPrefix, mruSnapshot, recordUse } from "@/modules/command-palette/lib/mru";
import {
  AiBrowserIcon,
  ComputerTerminal02Icon,
  ContainerTruckIcon,
  Delete02Icon,
  GitBranchIcon,
  Globe02Icon,
  IncognitoIcon,
  PencilEdit02Icon,
  PlusSignIcon,
  ServerStack03Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState } from "react";
import {
  groupProfiles,
  NEW_TAB_MRU_PREFIX,
  parseQuickConnect,
  quickConnectId,
  rankProfiles,
  recentProfiles,
  type NewTabProfile,
} from "./lib/newTabProfiles";

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

const ICONS = {
  tab: ComputerTerminal02Icon,
  ssh: ServerStack03Icon,
  docker: ContainerTruckIcon,
  zellij: ComputerTerminal02Icon,
  quick: SparklesIcon,
} as const;

/** Per-action icons for the built-in tab profiles, which all share `tab`. */
const P = NEW_TAB_MRU_PREFIX;
const ICON_BY_ID: Partial<Record<string, (typeof ICONS)[keyof typeof ICONS]>> =
  {
    [`${P}blocks`]: ComputerTerminal02Icon,
    [`${P}agents`]: AiBrowserIcon,
    [`${P}private`]: IncognitoIcon,
    [`${P}editor`]: PencilEdit02Icon,
    [`${P}preview`]: Globe02Icon,
    [`${P}git-graph`]: GitBranchIcon,
  };

/**
 * The `+` menu. A searchable profile picker rather than a flat dropdown: type
 * to fuzzy-match actions, hosts and their exec/session entries, or an
 * `user@host` address to connect somewhere new. Recently launched profiles
 * surface first, the way a launcher is expected to behave.
 */
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
  const [query, setQuery] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [mruNonce, setMruNonce] = useState(0);

  const mru = useMemo(
    () => (menuOpen ? mruSnapshot() : {}),
    // mruNonce re-reads after something is launched or cleared.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [menuOpen, mruNonce],
  );

  useEffect(() => {
    if (!menuOpen) return;
    setQuery("");
    setValue("");
    setError(null);
  }, [menuOpen]);

  const profiles = useMemo<NewTabProfile[]>(() => {
    const list: NewTabProfile[] = [
      {
        id: `${NEW_TAB_MRU_PREFIX}terminal`,
        kind: "tab",
        title: "Terminal",
        detail: fmtShortcut(MOD_KEY, "T"),
        keywords: ["shell", "bash", "zsh"],
        run: onNew,
      },
      {
        id: `${NEW_TAB_MRU_PREFIX}blocks`,
        kind: "tab",
        title: "Blocks",
        detail: fmtShortcut(MOD_KEY, SHIFT_KEY, "T"),
        keywords: ["prompt", "shell"],
        run: onNewBlock,
      },
      {
        id: `${NEW_TAB_MRU_PREFIX}agents`,
        kind: "tab",
        title: "Agents",
        keywords: ["ai", "claude", "codex"],
        // Staggered: opening the launcher in the same tick as the menu closes
        // lets Radix treat the selecting click as an outside press and
        // dismiss the launcher immediately.
        run: () => requestAnimationFrame(() => setLauncherOpen(true)),
      },
      {
        id: `${NEW_TAB_MRU_PREFIX}private`,
        kind: "tab",
        title: "Private terminal",
        detail: fmtShortcut(MOD_KEY, "R"),
        keywords: ["incognito", "hidden", "secret"],
        run: onNewPrivate,
      },
      {
        id: `${NEW_TAB_MRU_PREFIX}editor`,
        kind: "tab",
        title: "Editor",
        detail: fmtShortcut(MOD_KEY, "E"),
        keywords: ["file", "code"],
        run: onNewEditor,
      },
      {
        id: `${NEW_TAB_MRU_PREFIX}preview`,
        kind: "tab",
        title: "Preview",
        detail: fmtShortcut(MOD_KEY, "P"),
        keywords: ["browser", "web", "url"],
        run: onNewPreview,
      },
      {
        id: `${NEW_TAB_MRU_PREFIX}git-graph`,
        kind: "tab",
        title: "Git Graph",
        keywords: ["history", "commits", "log"],
        run: onNewGitGraph,
      },
    ];

    for (const host of hosts) {
      const target = `${host.user}@${host.hostname}${host.port === 22 ? "" : `:${host.port}`}`;
      if (onNewSshHost) {
        list.push({
          id: `${NEW_TAB_MRU_PREFIX}ssh:${host.id}`,
          kind: "ssh",
          title: host.alias,
          detail: target,
          keywords: [host.hostname, host.user, "ssh", "connect"],
          run: () => onNewSshHost(host),
        });
      }
      if (onNewDockerExec) {
        list.push({
          id: `${NEW_TAB_MRU_PREFIX}docker:${host.id}`,
          kind: "docker",
          title: host.alias,
          detail: target,
          keywords: [host.hostname, "exec", "container", "docker"],
          run: () => onNewDockerExec(host),
        });
      }
      if (onNewZellijHost) {
        list.push({
          id: `${NEW_TAB_MRU_PREFIX}zellij:${host.id}`,
          kind: "zellij",
          title: host.alias,
          detail: target,
          keywords: [host.hostname, "session", "multiplexer", "zellij"],
          run: () => onNewZellijHost(host),
        });
      }
    }
    return list;
  }, [
    hosts,
    onNew,
    onNewBlock,
    onNewPrivate,
    onNewPreview,
    onNewEditor,
    onNewGitGraph,
    onNewSshHost,
    onNewDockerExec,
    onNewZellijHost,
  ]);

  const quick = onNewSshHost ? parseQuickConnect(query) : null;

  const quickProfile = useMemo<NewTabProfile | null>(() => {
    if (!quick || !onNewSshHost) return null;
    return {
      id: quickConnectId(quick),
      kind: "quick",
      title: `Connect to ${quick.user}@${quick.host}`,
      detail: quick.port ? `port ${quick.port}` : "port 22",
      keywords: [quick.host, quick.user, "connect", "ssh"],
      run: () => {
        void (async () => {
          try {
            const saved = await saveHost({
              id: null,
              alias: quick.host,
              user: quick.user,
              hostname: quick.host,
              port: quick.port ?? 22,
            });
            onNewSshHost(saved);
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setMenuOpen(true);
          }
        })();
      },
    };
  }, [quick, onNewSshHost]);

  const candidates = useMemo(
    () => (quickProfile ? [quickProfile, ...profiles] : profiles),
    [quickProfile, profiles],
  );

  const ranked = useMemo(
    () => rankProfiles(candidates, query, mru),
    [candidates, query, mru],
  );

  const recents = useMemo(
    () => (query.trim() ? [] : recentProfiles(profiles, mru, 5)),
    // mruNonce re-reads the store after a launch or a clear.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [profiles, mru, query, mruNonce],
  );

  const groups = useMemo(() => groupProfiles(ranked), [ranked]);

  const choose = (profile: NewTabProfile) => {
    recordUse(profile.id);
    setMruNonce((n) => n + 1);
    setMenuOpen(false);
    profile.run();
  };

  const launchAgents = (request: AgentLaunchRequest) => {
    setLauncherOpen(false);
    onLaunchAgents(request);
  };

  return (
    <Popover open={launcherOpen} onOpenChange={setLauncherOpen}>
      <PopoverAnchor asChild>
        <span className="inline-flex">
          <Popover open={menuOpen} onOpenChange={setMenuOpen}>
            <PopoverAnchor asChild>
              <button
                type="button"
                aria-label="New tab"
                title="New tab"
                onClick={() => setMenuOpen((v) => !v)}
                className="ml-1 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground/[0.06] text-muted-foreground ring-1 ring-inset ring-foreground/[0.04] transition-colors hover:bg-foreground/[0.12] hover:text-foreground"
              >
                <HugeiconsIcon icon={PlusSignIcon} size={14} strokeWidth={2} />
              </button>
            </PopoverAnchor>
            <PopoverContent
              align="start"
              sideOffset={6}
              className="w-[380px] gap-0 overflow-hidden rounded-2xl p-0"
            >
              <Command
                shouldFilter={false}
                loop
                value={value}
                onValueChange={setValue}
              >
                <CommandInput
                  autoFocus
                  value={query}
                  onValueChange={setQuery}
                  placeholder="New tab: search a profile, or type user@host"
                  className="text-[12.5px]"
                />
                <CommandList className="max-h-[420px]">
                  {error ? (
                    <div className="mx-2 mt-1 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] leading-relaxed text-destructive">
                      {error}
                    </div>
                  ) : null}

                  {recents.length > 0 ? (
                    <CommandGroup heading="Recent">
                      {recents.map((profile) => (
                        <ProfileItem
                          key={`recent-${profile.id}`}
                          profile={profile}
                          onSelect={() => choose(profile)}
                        />
                      ))}
                      <CommandItem
                        value="newtab:clear-recents"
                        className="text-[12px] text-muted-foreground"
                        onSelect={() => {
                          clearMruPrefix(NEW_TAB_MRU_PREFIX);
                          setMruNonce((n) => n + 1);
                        }}
                      >
                        <HugeiconsIcon
                          icon={Delete02Icon}
                          size={14}
                          strokeWidth={1.75}
                        />
                        <span>Clear recent profiles</span>
                      </CommandItem>
                    </CommandGroup>
                  ) : null}

                  {groups.length === 0 ? (
                    <CommandEmpty className="py-8 text-[12px] text-muted-foreground">
                      No profile matches “{query.trim()}”. Type user@host to
                      connect somewhere new.
                    </CommandEmpty>
                  ) : (
                    groups.map(({ group, profiles: rows }) => (
                      <CommandGroup key={group} heading={group}>
                        {rows.map((profile) => (
                          <ProfileItem
                            key={profile.id}
                            profile={profile}
                            onSelect={() => choose(profile)}
                          />
                        ))}
                      </CommandGroup>
                    ))
                  )}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </span>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[340px] gap-0 overflow-hidden rounded-2xl p-1.5"
      >
        <AgentLauncherPanel
          onBack={() => {
            setLauncherOpen(false);
            requestAnimationFrame(() => setMenuOpen(true));
          }}
          onLaunch={launchAgents}
        />
      </PopoverContent>
    </Popover>
  );
}

function ProfileItem({
  profile,
  onSelect,
}: {
  profile: NewTabProfile;
  onSelect: () => void;
}) {
  const Icon = ICON_BY_ID[profile.id] ?? ICONS[profile.kind];
  return (
    <CommandItem
      value={profile.id}
      onSelect={onSelect}
      className="text-[12.5px]"
    >
      <HugeiconsIcon
        icon={Icon}
        size={14}
        strokeWidth={1.75}
        className="text-muted-foreground"
      />
      {/* Title gets the full row so an alias never truncates to "10.123.38…";
          the target rides on the right instead. */}
      <span className="min-w-0 flex-1 truncate">{profile.title}</span>
      {profile.detail ? (
        <CommandShortcut className="max-w-[45%] truncate font-mono text-[10.5px] tracking-normal">
          {profile.detail}
        </CommandShortcut>
      ) : null}
    </CommandItem>
  );
}
