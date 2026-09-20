import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  type CustomEndpoint,
  DEFAULT_COMPAT_ENDPOINT_NAME,
  type EndpointModel,
  endpointConfigured,
  endpointIdForSelection,
  modelIdForSelection,
  modelSelectionKey,
} from "@/modules/ai/config";
import {
  clearCustomEndpointKey,
  getAllCustomEndpointKeys,
  type CustomEndpointKeys,
  setCustomEndpointKey,
} from "@/modules/ai/lib/keyring";
import { useEndpointCatalog } from "@/modules/ai/lib/endpointCatalog";
import { pushRecentModel } from "@/modules/ai/lib/modelPrefs";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  type AutocompleteTrigger,
  emitKeysChanged,
  setAutocompleteEnabled,
  setAutocompleteEndpointId,
  setAutocompleteModelId,
  setAutocompleteTrigger,
  setCustomEndpoints,
  setDefaultModel,
} from "@/modules/settings/store";
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowUpRight01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  ChevronDown,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { ProviderIcon } from "../components/ProviderIcon";
import { SectionHeader } from "../components/SectionHeader";

type Catalog = ReturnType<typeof useEndpointCatalog.getState>["entries"];

export function ModelsSection() {
  const endpoints = usePreferencesStore((s) => s.customEndpoints);
  const [epKeys, setEpKeys] = useState<CustomEndpointKeys>({});
  const catalog = useEndpointCatalog((s) => s.entries);
  const loadCatalog = useEndpointCatalog((s) => s.load);

  useEffect(() => {
    void getAllCustomEndpointKeys(endpoints).then(setEpKeys);
  }, [endpoints]);

  useEffect(() => {
    for (const ep of endpoints) {
      void loadCatalog(ep, epKeys[ep.id] ?? null);
    }
  }, [endpoints, epKeys, loadCatalog]);

  const addEndpoint = async () => {
    const ep: CustomEndpoint = {
      id: crypto.randomUUID().slice(0, 8),
      name: "",
      baseURL: "",
      contextLimit: 128_000,
    };
    await setCustomEndpoints([...endpoints, ep]);
  };

  const updateEndpoint = async (id: string, patch: Partial<CustomEndpoint>) => {
    await setCustomEndpoints(
      endpoints.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    );
  };

  const removeEndpoint = async (id: string) => {
    await clearCustomEndpointKey(id);
    setEpKeys((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    const { selectedModelId, setSelectedModelId } = useChatStore.getState();
    if (endpointIdForSelection(selectedModelId) === id) {
      setSelectedModelId("");
    }
    await setCustomEndpoints(endpoints.filter((e) => e.id !== id));
  };

  const saveEndpointKey = async (id: string, value: string) => {
    await setCustomEndpointKey(id, value);
    setEpKeys((prev) => ({ ...prev, [id]: value }));
    await emitKeysChanged();
  };

  const clearEndpointKey = async (id: string) => {
    await clearCustomEndpointKey(id);
    setEpKeys((prev) => ({ ...prev, [id]: null }));
    await emitKeysChanged();
  };

  return (
    <div className="flex flex-col gap-7">
      <SectionHeader
        title="Models"
        description="Connect any OpenAI-compatible endpoint. Models are discovered from {baseURL}/models; keys live in your OS keychain."
      />

      <DefaultsBlock catalog={catalog} />
      <AutocompleteBlock catalog={catalog} />

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <Label>Endpoints</Label>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void addEndpoint()}
            className="h-7 gap-1.5 px-2.5 text-[11px]"
          >
            <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={2} />
            Add endpoint
          </Button>
        </div>

        {endpoints.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 bg-card/40 px-4 py-8 text-center">
            <p className="text-[12px] text-muted-foreground">
              No endpoints connected yet.
            </p>
            <p className="mt-0.5 text-[10.5px] text-muted-foreground/70">
              Add an OpenAI-compatible base URL (OpenAI, OpenRouter, vLLM, …).
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {endpoints.map((ep) => (
              <EndpointCard
                key={ep.id}
                endpoint={ep}
                apiKey={epKeys[ep.id] ?? null}
                onUpdate={(patch) => updateEndpoint(ep.id, patch)}
                onSaveKey={(v) => saveEndpointKey(ep.id, v)}
                onClearKey={() => clearEndpointKey(ep.id)}
                onRemove={() => removeEndpoint(ep.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DefaultsBlock({ catalog }: { catalog: Catalog }) {
  const endpoints = usePreferencesStore((s) => s.customEndpoints);
  const defaultModel = usePreferencesStore((s) => s.defaultModelId);
  const setSelected = useChatStore((s) => s.setSelectedModelId);
  const configured = endpoints.filter(endpointConfigured);
  const defaultEndpointId = endpointIdForSelection(defaultModel);
  const selectedModel = modelIdForSelection(defaultModel);
  const defaultEndpointExists = endpoints.some(
    (e) => e.id === defaultEndpointId,
  );
  const label =
    defaultEndpointExists && selectedModel
      ? selectedModel
      : "No model selected";

  // Auto-select the first model of the first configured endpoint so the main
  // window has a usable default without a manual pick.
  useEffect(() => {
    if (label !== "No model selected") return;
    const first = configured[0];
    if (!first) return;
    const models = catalog[first.id]?.models ?? [];
    const model = models[0];
    if (!model) return;
    const id = modelSelectionKey(first.id, model.id);
    void setDefaultModel(id);
    setSelected(id);
  }, [label, configured, catalog, setDefaultModel, setSelected]);

  const pick = async (ep: CustomEndpoint, model: EndpointModel) => {
    const id = modelSelectionKey(ep.id, model.id);
    await setDefaultModel(id);
    setSelected(id);
    await pushRecentModel(id);
  };

  return (
    <div className="flex flex-col gap-3">
      <Label>Defaults</Label>
      <div className="flex flex-col gap-2.5 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
        <FieldRow label="Chat model">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                disabled={configured.length === 0}
                className="h-8 flex-1 justify-between gap-2 px-2.5 text-[11.5px]"
              >
                <span className="flex items-center gap-2 truncate">
                  <ProviderIcon size={13} />
                  <span className="truncate">{label}</span>
                </span>
                <HugeiconsIcon
                  icon={ArrowDown01Icon}
                  size={11}
                  strokeWidth={2}
                  className="opacity-70"
                />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              side="bottom"
              sideOffset={6}
              collisionPadding={12}
              className="min-w-70 p-1"
            >
              <div className="max-h-72 overflow-y-auto overscroll-contain pr-1">
                {configured.map((ep) => {
                  const models = catalog[ep.id]?.models ?? [];
                  return (
                    <div key={ep.id} className="px-1 pt-1.5 first:pt-1">
                      <div className="mb-0.5 flex items-center gap-1.5 px-2 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                        <ProviderIcon size={11} />
                        <span>{ep.name || ep.baseURL}</span>
                      </div>
                      {models.length === 0 ? (
                        <p className="px-2 py-1 text-[10.5px] text-muted-foreground/70">
                          No models found.
                        </p>
                      ) : (
                        models.map((m) => (
                          <DropdownMenuItem
                            key={m.id}
                            onSelect={() => void pick(ep, m)}
                            className={cn(
                              "flex items-start gap-2 text-[12px]",
                              modelSelectionKey(ep.id, m.id) === defaultModel &&
                                "bg-accent/50",
                            )}
                          >
                            <span className="flex flex-1 flex-col">
                              <span>{m.id}</span>
                              {m.pricing ? (
                                <span className="text-[10px] text-muted-foreground">
                                  ${m.pricing.input}/M in · ${m.pricing.output}
                                  /M out
                                </span>
                              ) : null}
                            </span>
                          </DropdownMenuItem>
                        ))
                      )}
                    </div>
                  );
                })}
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        </FieldRow>
      </div>
    </div>
  );
}

function AutocompleteBlock({ catalog }: { catalog: Catalog }) {
  const enabled = usePreferencesStore((s) => s.autocompleteEnabled);
  const trigger = usePreferencesStore((s) => s.autocompleteTrigger);
  const endpointId = usePreferencesStore((s) => s.autocompleteEndpointId);
  const modelId = usePreferencesStore((s) => s.autocompleteModelId);
  const endpoints = usePreferencesStore((s) => s.customEndpoints);
  const currentEp = endpoints.find((e) => e.id === endpointId);
  const models =
    currentEp && catalog[currentEp.id]
      ? (catalog[currentEp.id].models ?? [])
      : [];

  const pickEndpoint = (id: string) => {
    void setAutocompleteEndpointId(id);
    void setAutocompleteModelId("");
  };

  const currentLabel = modelId || "No model selected";

  return (
    <div className="flex flex-col gap-3">
      <Label>Autocomplete</Label>
      <div className="flex flex-col gap-2.5 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
        <FieldRow label="Enabled">
          <Switch
            checked={enabled}
            onCheckedChange={(v) => void setAutocompleteEnabled(v)}
          />
        </FieldRow>

        <FieldRow label="Endpoint">
          <Select value={endpointId} onValueChange={pickEndpoint}>
            <SelectTrigger className="h-8 w-full text-[11.5px]">
              <SelectValue placeholder="Select an endpoint" />
            </SelectTrigger>
            <SelectContent>
              {endpoints.map((ep) => (
                <SelectItem key={ep.id} value={ep.id}>
                  {ep.name || ep.baseURL || "Endpoint"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FieldRow>

        <FieldRow label="Model">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                disabled={!currentEp}
                className="h-8 flex-1 justify-between gap-2 px-2.5 text-[11.5px]"
              >
                <span className="flex items-center gap-2 truncate">
                  <ProviderIcon size={12} />
                  <span className="truncate">{currentLabel}</span>
                </span>
                <HugeiconsIcon
                  icon={ArrowDown01Icon}
                  size={11}
                  strokeWidth={2}
                  className="opacity-70"
                />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              collisionPadding={12}
              className="max-h-72 min-w-70 overflow-y-auto"
            >
              {models.length === 0 ? (
                <p className="px-2 py-1.5 text-[10.5px] text-muted-foreground/70">
                  No models found.
                </p>
              ) : (
                models.map((m) => (
                  <DropdownMenuItem
                    key={m.id}
                    onSelect={() => void setAutocompleteModelId(m.id)}
                    className={cn(
                      "text-[11.5px]",
                      m.id === modelId && "bg-accent/50",
                    )}
                  >
                    <span className="flex flex-col">
                      <span>{m.id}</span>
                      {m.pricing ? (
                        <span className="text-[10px] text-muted-foreground">
                          ${m.pricing.input}/M in · ${m.pricing.output}/M out
                        </span>
                      ) : null}
                    </span>
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </FieldRow>

        {enabled ? (
          <FieldRow label="Trigger">
            <Select
              value={trigger}
              onValueChange={(v) =>
                void setAutocompleteTrigger(v as AutocompleteTrigger)
              }
            >
              <SelectTrigger className="h-8 w-full text-[11.5px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Automatic (as you type)</SelectItem>
                <SelectItem value="manual">Manual (shortcut)</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
        ) : null}
      </div>
    </div>
  );
}

function EndpointCard({
  endpoint,
  apiKey,
  onUpdate,
  onSaveKey,
  onClearKey,
  onRemove,
}: {
  endpoint: CustomEndpoint;
  apiKey: string | null;
  onUpdate: (patch: Partial<CustomEndpoint>) => Promise<void>;
  onSaveKey: (v: string) => Promise<void>;
  onClearKey: () => Promise<void>;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(!endpoint.baseURL.trim());
  const [nameDraft, setNameDraft] = useState(endpoint.name);
  const [urlDraft, setUrlDraft] = useState(endpoint.baseURL);
  const [contextDraft, setContextDraft] = useState(
    String(endpoint.contextLimit ?? ""),
  );
  const [keyDraft, setKeyDraft] = useState("");
  const [testStatus, setTestStatus] = useState<
    "idle" | "testing" | "ok" | "fail"
  >("idle");

  useEffect(() => setNameDraft(endpoint.name), [endpoint.name]);
  useEffect(() => setUrlDraft(endpoint.baseURL), [endpoint.baseURL]);
  useEffect(
    () => setContextDraft(String(endpoint.contextLimit ?? "")),
    [endpoint.contextLimit],
  );

  const configured = endpointConfigured(endpoint);

  const test = async () => {
    setTestStatus("testing");
    try {
      const status = await invoke<number>("lm_ping", { baseUrl: urlDraft });
      setTestStatus(status > 0 ? "ok" : "fail");
    } catch {
      setTestStatus("fail");
    }
  };

  return (
    <div className="flex flex-col rounded-lg border border-border/60 bg-card/60">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 px-3 py-2 text-left"
      >
        <HugeiconsIcon
          icon={ChevronDown}
          size={12}
          strokeWidth={2}
          className={cn(
            "shrink-0 text-muted-foreground/60 transition-transform",
            !expanded && "-rotate-90",
          )}
        />
        <ProviderIcon size={15} />
        <span className="text-[12.5px] font-medium truncate">
          {endpoint.name || endpoint.baseURL || DEFAULT_COMPAT_ENDPOINT_NAME}
        </span>
        {configured ? (
          <Badge
            variant="outline"
            className="ml-1 h-4 gap-1 border-border/60 bg-muted/40 px-1.5 text-[10px] font-normal text-muted-foreground"
          >
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              size={9}
              strokeWidth={2}
            />
            Connected
          </Badge>
        ) : null}
        <Button
          size="icon"
          variant="ghost"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          title="Remove endpoint"
          className="ml-auto size-7 text-muted-foreground hover:text-destructive"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />
        </Button>
      </button>

      {expanded && (
        <div className="flex flex-col gap-2.5 border-t border-border/40 px-3 py-2.5">
          <FieldRow label="Name">
            <Input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => {
                const v = nameDraft.trim();
                if (v !== endpoint.name) void onUpdate({ name: v });
              }}
              placeholder="OpenAI"
              spellCheck={false}
              className="h-8 flex-1 text-[11.5px]"
            />
          </FieldRow>

          <FieldRow label="Base URL">
            <div className="flex flex-1 gap-1.5">
              <Input
                value={urlDraft}
                onChange={(e) => setUrlDraft(e.target.value)}
                onBlur={() => {
                  const v = urlDraft.trim();
                  if (v !== endpoint.baseURL) void onUpdate({ baseURL: v });
                }}
                placeholder="https://api.openai.com/v1"
                spellCheck={false}
                className="h-8 flex-1 font-mono text-[11.5px]"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => void test()}
                disabled={!urlDraft.trim()}
                className="h-8 px-3 text-[11px]"
              >
                Test
              </Button>
            </div>
          </FieldRow>

          <FieldRow label="API key">
            {apiKey ? (
              <div className="flex flex-1 items-center gap-1.5">
                <code className="flex-1 truncate rounded bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground">
                  {`${apiKey.slice(0, 4)}${"•".repeat(8)}${apiKey.slice(-4)}`}
                </code>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => void onClearKey()}
                  title="Remove key"
                  className="size-7 text-muted-foreground hover:text-destructive"
                >
                  <HugeiconsIcon
                    icon={Cancel01Icon}
                    size={12}
                    strokeWidth={1.75}
                  />
                </Button>
              </div>
            ) : (
              <div className="flex flex-1 gap-1.5">
                <Input
                  type="password"
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  placeholder="Optional — leave empty for unauthenticated endpoints"
                  spellCheck={false}
                  className="h-8 flex-1 font-mono text-[11.5px]"
                />
                <Button
                  size="sm"
                  onClick={async () => {
                    const v = keyDraft.trim();
                    if (!v) return;
                    await onSaveKey(v);
                    setKeyDraft("");
                  }}
                  disabled={!keyDraft.trim()}
                  className="h-8 px-3 text-[11px]"
                >
                  Save
                </Button>
              </div>
            )}
          </FieldRow>

          <FieldRow label="Context">
            <div className="flex flex-1 items-center gap-1.5">
              <Input
                value={contextDraft}
                onChange={(e) => setContextDraft(e.target.value)}
                onBlur={() => {
                  const v = parseInt(contextDraft);
                  if (Number.isFinite(v) && v >= 1000)
                    void onUpdate({ contextLimit: v });
                  else setContextDraft(String(endpoint.contextLimit ?? ""));
                }}
                placeholder="128000"
                spellCheck={false}
                className="h-8 w-28 font-mono text-[11.5px]"
              />
              <span className="text-[10.5px] text-muted-foreground">
                tokens (fallback when models.dev has none)
              </span>
            </div>
          </FieldRow>

          <button
            type="button"
            onClick={() =>
              void openUrl("https://platform.openai.com/docs/api-reference")
            }
            className="inline-flex w-fit items-center gap-0.5 text-[10.5px] text-muted-foreground transition-colors hover:text-foreground"
          >
            API reference
            <HugeiconsIcon
              icon={ArrowUpRight01Icon}
              size={11}
              strokeWidth={1.75}
            />
          </button>

          <StatusLine status={testStatus} />
        </div>
      )}
    </div>
  );
}

function FieldRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-[11px] tracking-tight text-muted-foreground">
        {label}
      </span>
      <div className="flex flex-1 items-center">{children}</div>
    </div>
  );
}

function StatusLine({
  status,
}: {
  status: "idle" | "testing" | "ok" | "fail";
}) {
  if (status === "idle") return null;
  if (status === "testing") {
    return (
      <span className="text-[10.5px] text-muted-foreground">Testing…</span>
    );
  }
  if (status === "ok") {
    return (
      <span className="flex items-center gap-1 text-[10.5px] text-muted-foreground">
        <HugeiconsIcon icon={CheckmarkCircle02Icon} size={11} strokeWidth={2} />
        Reachable — server responded.
      </span>
    );
  }
  return (
    <span className="text-[10.5px] text-destructive/80">
      Could not reach the server.
    </span>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}
