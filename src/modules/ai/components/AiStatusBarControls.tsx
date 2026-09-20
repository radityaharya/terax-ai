import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { fmtShortcut, MOD_KEY } from "@/lib/platform";
import { cn } from "@/lib/utils";
import {
  type CustomEndpoint,
  endpointIdForSelection,
  type EndpointModel,
  modelIdForSelection,
  modelSelectionKey,
} from "@/modules/ai/config";
import { ACCEPTED_FILES, useComposer } from "@/modules/ai/lib/composer";
import { useEndpointCatalog } from "@/modules/ai/lib/endpointCatalog";
import {
  detectProviderId,
  labLogoUrl,
  providerLogoUrl,
} from "@/modules/ai/lib/modelMetadata";
import {
  pushRecentModel,
  toggleFavoriteModel,
} from "@/modules/ai/lib/modelPrefs";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setDefaultModel } from "@/modules/settings/store";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import {
  Add01Icon,
  AiBookIcon,
  ArrowDown01Icon,
  ArrowUpIcon,
  Clock01Icon,
  FavouriteIcon,
  Message01Icon,
  PlugIcon,
  Search01Icon,
  Settings01Icon,
  StarIcon,
  StopCircleIcon,
  Tick01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useRef, useState } from "react";

export function AiOpenButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex h-6 items-center gap-1.5 rounded-md border border-border/60 bg-card px-2 text-xs",
        "text-muted-foreground transition-colors hover:border-border hover:bg-accent hover:text-foreground",
        "animate-in slide-in-from-top-2 duration-200 ease-out",
      )}
      title="Open AI agent"
    >
      <span>Open AI agent</span>
      <Kbd className="h-4 min-w-4 px-1">{fmtShortcut(MOD_KEY, "I")}</Kbd>
    </button>
  );
}

export function AiStatusBarControls() {
  const c = useComposer();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toggleMini = useChatStore((s) => s.toggleMini);
  const miniOpen = useChatStore((s) => s.mini.open);
  const closePanel = useChatStore((s) => s.closePanel);

  return (
    <div className="flex items-center gap-0.5">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ACCEPTED_FILES}
        className="hidden"
        onChange={(e) => {
          void c.addFiles(e.target.files);
          e.target.value = "";
        }}
      />

      <IconBtn
        title="Attach file or image"
        onClick={() => fileInputRef.current?.click()}
        disabled={c.isBusy}
      >
        <HugeiconsIcon icon={Add01Icon} size={13} strokeWidth={2} />
      </IconBtn>

      <ModelDropdown />

      <span className="mx-1 h-8 w-px bg-border" aria-hidden />
      <Button
        onClick={closePanel}
        title="Close AI panel"
        size="xs"
        variant="ghost"
        aria-label="Close AI panel"
        className="text-[11px] text-foreground/85 px-1"
      >
        <Kbd className="h-4 gap-px px-2 font-mono text-[11px]">
          {fmtShortcut(MOD_KEY, "I")}
        </Kbd>
      </Button>
      <IconBtn
        title={`${miniOpen ? "Close" : "Open"} AI chat window (${fmtShortcut("⇧", MOD_KEY, "I")})`}
        onClick={toggleMini}
      >
        <HugeiconsIcon icon={Message01Icon} size={13} strokeWidth={1.75} />
      </IconBtn>

      {c.isBusy ? (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={c.stop}
          className="size-6"
          aria-label="Stop"
          title="Stop"
        >
          <HugeiconsIcon icon={StopCircleIcon} size={13} strokeWidth={1.75} />
        </Button>
      ) : (
        <Button
          type="button"
          size="icon"
          onClick={c.submit}
          disabled={!c.canSend}
          className="h-5.5 w-7.5 ml-1"
          aria-label="Send"
          title="Send (Enter)"
        >
          <HugeiconsIcon icon={ArrowUpIcon} size={13} strokeWidth={1.75} />
        </Button>
      )}
    </div>
  );
}

type Tab = "all" | "favorites" | "recent";

function ModelDropdown() {
  const selected = useChatStore((s) => s.selectedModelId);
  const setSelected = useChatStore((s) => s.setSelectedModelId);
  const endpointKeys = useChatStore((s) => s.customEndpointKeys);
  const favoriteIds = usePreferencesStore((s) => s.favoriteModelIds);
  const recentIds = usePreferencesStore((s) => s.recentModelIds);
  const endpoints = usePreferencesStore((s) => s.customEndpoints);
  const catalog = useEndpointCatalog((s) => s.entries);
  const loading = useEndpointCatalog((s) => s.loading);
  const loadCatalog = useEndpointCatalog((s) => s.load);

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeEndpoint, setActiveEndpoint] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("all");

  useEffect(() => {
    if (!open) return;
    for (const ep of endpoints) {
      void loadCatalog(ep, endpointKeys[ep.id] ?? null);
    }
  }, [open, endpoints, endpointKeys, loadCatalog]);

  const selectedEndpointId = endpointIdForSelection(selected);
  const currentEndpoint = endpoints.find((e) => e.id === selectedEndpointId);
  const currentLabel =
    modelIdForSelection(selected) ||
    currentEndpoint?.name ||
    "No model selected";

  const groups = useMemo(() => {
    return endpoints.map((ep) => ({
      endpoint: ep,
      models: catalog[ep.id]?.models ?? [],
    }));
  }, [endpoints, catalog]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = groups.flatMap((g) =>
      g.models.map((m) => ({ endpoint: g.endpoint, model: m })),
    );
    if (activeEndpoint !== null) {
      rows = rows.filter((r) => r.endpoint.id === activeEndpoint);
    }
    if (tab === "favorites") {
      rows = rows.filter((r) =>
        favoriteIds.includes(modelSelectionKey(r.endpoint.id, r.model.id)),
      );
    } else if (tab === "recent") {
      const order = new Map(recentIds.map((id, i) => [id, i]));
      rows = rows
        .filter((r) => order.has(modelSelectionKey(r.endpoint.id, r.model.id)))
        .sort(
          (a, b) =>
            (order.get(modelSelectionKey(a.endpoint.id, a.model.id)) ?? 0) -
            (order.get(modelSelectionKey(b.endpoint.id, b.model.id)) ?? 0),
        );
    }
    if (q) {
      rows = rows.filter(
        (r) =>
          r.model.id.toLowerCase().includes(q) ||
          r.model.label.toLowerCase().includes(q) ||
          r.endpoint.name.toLowerCase().includes(q),
      );
    }
    return rows;
  }, [activeEndpoint, favoriteIds, groups, recentIds, search, tab]);

  const pick = (endpoint: CustomEndpoint, model: EndpointModel) => {
    const selection = modelSelectionKey(endpoint.id, model.id);
    setSelected(selection);
    void setDefaultModel(selection);
    void pushRecentModel(selection);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-5.5 gap-1 rounded-md px-1.5 my-1 text-xs hover:bg-accent hover:text-foreground text-muted-foreground"
          title={`Model: ${currentLabel}`}
        >
          {currentLabel}
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={11}
            strokeWidth={2}
            className="opacity-70"
          />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        className="w-[28rem] p-0 overflow-hidden rounded-xl border border-border/70 shadow-xl"
      >
        <div className="flex items-center gap-2.5 border-b border-border/70 px-3 py-2.5">
          <HugeiconsIcon
            icon={Search01Icon}
            size={16}
            strokeWidth={1.75}
            className="shrink-0 text-muted-foreground/70"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="Search models"
            className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
          />
        </div>

        <div className="flex items-center gap-0.5 border-b border-border/70 px-2 py-1.5">
          <TabButton
            label="All"
            icon={AiBookIcon}
            active={tab === "all"}
            onClick={() => setTab("all")}
          />
          <TabButton
            label="Favorites"
            icon={FavouriteIcon}
            active={tab === "favorites"}
            onClick={() => setTab("favorites")}
            count={favoriteIds.length || undefined}
          />
          <TabButton
            label="Recent"
            icon={Clock01Icon}
            active={tab === "recent"}
            onClick={() => setTab("recent")}
            count={recentIds.length || undefined}
          />
        </div>

        <div className="flex max-h-104 min-h-0">
          <div className="flex w-11 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border/70 bg-muted/20 py-1.5">
            <ProviderPill
              icon={AiBookIcon}
              title="All endpoints"
              active={activeEndpoint === null}
              onClick={() => setActiveEndpoint(null)}
            />
            {endpoints.map((ep) => (
              <ProviderPill
                key={ep.id}
                providerId={detectProviderId(ep.baseURL)}
                title={ep.name || ep.baseURL || "Endpoint"}
                active={activeEndpoint === ep.id}
                onClick={() => setActiveEndpoint(ep.id)}
              />
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {endpoints.length === 0 ? (
              <EmptyEndpointCTA />
            ) : filtered.length === 0 ? (
              <div className="flex items-center justify-center px-4 py-10 text-xs text-muted-foreground/70">
                {Object.values(loading).some(Boolean)
                  ? "Loading models…"
                  : tab === "favorites"
                    ? "No favorites yet — star a model to pin it here."
                    : tab === "recent"
                      ? "No recently-used models."
                      : "No models match."}
              </div>
            ) : (
              filtered.map(({ endpoint, model }) => {
                const favoriteKey = modelSelectionKey(endpoint.id, model.id);
                return (
                  <ModelRow
                    key={`${endpoint.id}:${model.id}`}
                    model={model}
                    endpoint={endpoint}
                    selected={favoriteKey === selected}
                    favorite={favoriteIds.includes(favoriteKey)}
                    onPick={() => pick(endpoint, model)}
                    onToggleFavorite={() =>
                      void toggleFavoriteModel(favoriteKey)
                    }
                  />
                );
              })
            )}
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EmptyEndpointCTA() {
  return (
    <button
      type="button"
      onClick={() => void openSettingsWindow("models")}
      className="group mx-2 my-2 flex w-[calc(100%-1rem)] items-center gap-2 rounded-md border border-dashed border-border/70 bg-muted/20 px-3 py-2 text-left text-[11px] text-muted-foreground transition-colors hover:border-border hover:bg-accent/40 hover:text-foreground"
    >
      <HugeiconsIcon icon={Settings01Icon} size={13} strokeWidth={1.75} />
      <span className="flex-1 truncate">
        Add an OpenAI-compatible endpoint to pick a model.
      </span>
      <span className="shrink-0 text-[10px] underline-offset-2 group-hover:underline">
        Open
      </span>
    </button>
  );
}

function TabButton({
  label,
  icon,
  active,
  count,
  onClick,
}: {
  label: string;
  icon: typeof AiBookIcon;
  active: boolean;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
      )}
    >
      <HugeiconsIcon icon={icon} size={12} strokeWidth={1.75} />
      {label}
      {count != null ? (
        <span className="rounded-full bg-muted/60 px-1.5 text-[9.5px] tabular-nums text-muted-foreground">
          {count}
        </span>
      ) : null}
    </button>
  );
}

function ProviderPill({
  icon,
  providerId,
  title,
  active,
  onClick,
}: {
  icon?: typeof AiBookIcon;
  providerId?: string | null;
  title: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "relative mx-auto flex size-8 items-center justify-center rounded-md transition-colors",
        active
          ? "bg-accent text-foreground after:absolute after:right-0 after:top-1.5 after:bottom-1.5 after:w-[2px] after:rounded-full after:bg-primary after:content-['']"
          : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
      )}
    >
      {icon ? (
        <HugeiconsIcon icon={icon} size={16} strokeWidth={1.5} />
      ) : (
        <ModelLogo providerId={providerId ?? undefined} size={16} />
      )}
    </button>
  );
}

function ModelRow({
  model,
  endpoint,
  selected,
  favorite,
  onPick,
  onToggleFavorite,
}: {
  model: EndpointModel;
  endpoint: CustomEndpoint;
  selected: boolean;
  favorite: boolean;
  onPick: () => void;
  onToggleFavorite: () => void;
}) {
  return (
    <DropdownMenuItem
      onSelect={(e) => {
        e.preventDefault();
        onPick();
      }}
      className={cn(
        "group mx-1 my-0.5 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5",
        selected ? "bg-accent/60 text-foreground" : "text-foreground/85",
      )}
    >
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onToggleFavorite();
        }}
        title={favorite ? "Unfavorite" : "Favorite"}
        className={cn(
          "shrink-0 rounded p-0.5 transition-colors",
          favorite
            ? "text-amber-500"
            : "text-muted-foreground/40 hover:text-amber-500",
        )}
      >
        <HugeiconsIcon
          icon={StarIcon}
          size={12}
          strokeWidth={favorite ? 2 : 1.75}
          className={favorite ? "fill-amber-500" : ""}
        />
      </button>

      <ModelLogo lab={model.lab} />

      <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="shrink-0 text-[12px] font-medium leading-none">
          {model.id}
        </span>
        <span className="truncate text-[10.5px] leading-none text-muted-foreground">
          {endpoint.name || endpoint.baseURL}
          {model.contextLimit
            ? ` · ${Math.round(model.contextLimit / 1000)}k ctx`
            : ""}
          {model.reasoning ? " · reasoning" : ""}
          {model.vision ? " · vision" : ""}
        </span>
      </div>

      {model.pricing ? <PricingBadge model={model} /> : null}

      {selected ? (
        <HugeiconsIcon
          icon={Tick01Icon}
          size={13}
          strokeWidth={2}
          className="shrink-0 text-foreground"
        />
      ) : null}
    </DropdownMenuItem>
  );
}

function ModelLogo({
  lab,
  providerId,
  size = 13,
}: {
  lab?: string | null;
  providerId?: string | null;
  size?: number;
}) {
  const url = labLogoUrl(lab) ?? providerLogoUrl(providerId);
  if (!url) {
    return (
      <HugeiconsIcon
        icon={PlugIcon}
        size={size}
        strokeWidth={1.5}
        className="shrink-0 text-muted-foreground/70"
      />
    );
  }
  // models.dev logos are single-path `fill="currentColor"` SVGs. Loaded as an
  // <img> they resolve to black (invisible on dark themes), so mask them and
  // paint with currentColor instead — the logo then follows the text color.
  return (
    <span
      aria-hidden
      className="shrink-0 bg-current opacity-80"
      style={{
        width: size,
        height: size,
        WebkitMaskImage: `url("${url}")`,
        maskImage: `url("${url}")`,
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
        WebkitMaskSize: "contain",
        maskSize: "contain",
      }}
    />
  );
}

function PricingBadge({ model }: { model: EndpointModel }) {
  const p = model.pricing;
  if (!p) return null;
  return (
    <span
      className="ml-auto shrink-0 tabular-nums text-[10px] text-muted-foreground/80"
      title={`$${p.input}/M in · $${p.output}/M out`}
    >
      ${formatPrice(p.input)}/${formatPrice(p.output)}
    </span>
  );
}

function formatPrice(v: number): string {
  if (v === 0) return "0";
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(2).replace(/\.?0+$/, "");
}

function IconBtn({
  title,
  onClick,
  disabled,
  className,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "size-6 rounded-md text-muted-foreground hover:text-foreground",
        className,
      )}
    >
      {children}
    </Button>
  );
}
