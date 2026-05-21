import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  setBackgroundBlur,
  setBackgroundImageId,
  setBackgroundKind,
  setBackgroundOpacity,
} from "@/modules/settings/store";
import { useTheme } from "@/modules/theme";
import {
  deleteBgImage,
  importBgImageFromFile,
} from "@/modules/theme/bgImageStore";
import { deleteCustomTheme, saveCustomTheme } from "@/modules/theme/customThemes";
import { listBuiltinThemes } from "@/modules/theme/themes";
import { validateTheme } from "@/modules/theme/validateTheme";
import { DEFAULT_THEME_ID, type Theme } from "@/modules/theme/types";
import { json } from "@codemirror/lang-json";
import { EditorView } from "@codemirror/view";
import { color } from "@uiw/codemirror-extensions-color";
import { Edit02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import CodeMirror from "@uiw/react-codemirror";
import { useMemo, useRef, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";

export function ThemesSection() {
  const { themeId, setThemeId, resolvedMode, customThemes } = useTheme();
  const builtinThemes = listBuiltinThemes();
  const themes = useMemo(
    () => [...builtinThemes, ...customThemes],
    [builtinThemes, customThemes],
  );
  const customIds = useMemo(
    () => new Set(customThemes.map((t) => t.id)),
    [customThemes],
  );

  const [importError, setImportError] = useState<string | null>(null);
  const [bgError, setBgError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const bgInputRef = useRef<HTMLInputElement | null>(null);

  const [editing, setEditing] = useState<Theme | null>(null);

  const onCreateTheme = () => {
    const id = `my-theme-${crypto.randomUUID().slice(0, 8)}`;
    const starter: Theme = {
      id,
      name: "My Theme",
      description: "Custom theme.",
      variants: {
        dark: {
          colors: {
            background: "#0d0d10",
            foreground: "#e8e8ea",
            card: "#15151a",
            cardForeground: "#e8e8ea",
            popover: "#15151a",
            popoverForeground: "#e8e8ea",
            primary: "#7dd3fc",
            primaryForeground: "#0d0d10",
            muted: "#1c1c22",
            mutedForeground: "#a0a0a8",
            accent: "#1c1c22",
            accentForeground: "#e8e8ea",
            border: "rgba(255,255,255,0.08)",
            input: "rgba(255,255,255,0.12)",
            ring: "#7dd3fc",
            sidebar: "#0a0a0d",
            sidebarForeground: "#e8e8ea",
            sidebarPrimary: "#7dd3fc",
            sidebarAccent: "#1c1c22",
            sidebarBorder: "rgba(255,255,255,0.08)",
            sidebarRing: "#7dd3fc",
          },
          terminal: {
            cursor: "#e8e8ea",
            cursorAccent: "#0d0d10",
            selection: "rgba(125,211,252,0.22)",
          },
        },
      },
    };
    setEditing(starter);
  };

  const backgroundKind = usePreferencesStore((s) => s.backgroundKind);
  const backgroundImageId = usePreferencesStore((s) => s.backgroundImageId);
  const backgroundOpacity = usePreferencesStore((s) => s.backgroundOpacity);
  const backgroundBlur = usePreferencesStore((s) => s.backgroundBlur);

  const handleThemeFiles = async (files: FileList | null) => {
    setImportError(null);
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const result = validateTheme(parsed);
        if (!result.ok) {
          setImportError(`${file.name}: ${result.error}`);
          return;
        }
        await saveCustomTheme(result.theme);
        setThemeId(result.theme.id);
      } catch (e) {
        setImportError(
          `${file.name}: ${e instanceof Error ? e.message : "failed to read"}`,
        );
        return;
      }
    }
  };

  const onPickThemeFile = () => fileInputRef.current?.click();

  const onRemoveCustomTheme = async (id: string) => {
    if (themeId === id) setThemeId(DEFAULT_THEME_ID);
    await deleteCustomTheme(id);
  };

  const onPickBgFile = () => bgInputRef.current?.click();

  const handleBgFiles = async (files: FileList | null) => {
    setBgError(null);
    if (!files || files.length === 0) return;
    const file = files[0];
    if (!file.type.startsWith("image/")) {
      setBgError(`${file.name}: not an image`);
      return;
    }
    try {
      const prev = backgroundImageId;
      const { id } = await importBgImageFromFile(file);
      await setBackgroundImageId(id);
      await setBackgroundKind("image");
      if (prev && prev !== id) await deleteBgImage(prev).catch(() => undefined);
    } catch (e) {
      setBgError(e instanceof Error ? e.message : "failed to import image");
    }
  };

  const onRemoveBackground = async () => {
    setBgError(null);
    const prev = backgroundImageId;
    await setBackgroundKind("none");
    await setBackgroundImageId(null);
    if (prev) await deleteBgImage(prev).catch(() => undefined);
  };

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Themes"
        description="Theme, background image, and customization."
      />

      <div
        className="flex flex-col gap-2"
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(e) => {
          e.preventDefault();
          void handleThemeFiles(e.dataTransfer.files);
        }}
      >
        <div className="flex items-center justify-between">
          <Label>Theme</Label>
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2 text-[11px]"
              onClick={onCreateTheme}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={11} strokeWidth={2} />
              Create
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={onPickThemeFile}
            >
              Import .terax-theme
            </Button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".terax-theme,.json,application/json"
            className="hidden"
            onChange={(e) => {
              void handleThemeFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
        {importError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11.5px] text-destructive">
            {importError}
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-2">
          {themes.map((t) => {
            const v =
              t.variants[resolvedMode] ?? t.variants.dark ?? t.variants.light;
            const c = v?.colors;
            const swatchBg = c?.background ?? "var(--background)";
            const swatchFg = c?.foreground ?? "var(--foreground)";
            const swatchAccent = c?.primary ?? c?.accent ?? "var(--accent)";
            const swatchMuted = c?.muted ?? "var(--muted)";
            const selected = themeId === t.id;
            const isCustom = customIds.has(t.id);
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setThemeId(t.id)}
                className={cn(
                  "group flex items-center gap-3 rounded-lg border p-2.5 text-left transition-all",
                  selected
                    ? "border-foreground/60 ring-1 ring-foreground/20"
                    : "border-border/60 hover:border-border",
                )}
              >
                <div
                  className="flex h-10 w-14 shrink-0 items-center justify-center gap-1 rounded-md border border-border/40"
                  style={{ background: swatchBg }}
                >
                  <span
                    className="h-5 w-2 rounded-sm"
                    style={{ background: swatchAccent }}
                  />
                  <span
                    className="h-5 w-2 rounded-sm"
                    style={{ background: swatchFg, opacity: 0.7 }}
                  />
                  <span
                    className="h-5 w-2 rounded-sm"
                    style={{ background: swatchMuted }}
                  />
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[12.5px] font-medium">
                    {t.name}
                  </span>
                  {t.description ? (
                    <span className="truncate text-[11px] text-muted-foreground">
                      {t.description}
                    </span>
                  ) : null}
                </div>
                {isCustom ? (
                  <span className="ml-1 flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                    <span
                      role="button"
                      aria-label={`Edit ${t.name}`}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditing(t);
                      }}
                    >
                      <HugeiconsIcon icon={Edit02Icon} size={12} strokeWidth={1.75} />
                    </span>
                    <span
                      role="button"
                      aria-label={`Remove ${t.name}`}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onRemoveCustomTheme(t.id);
                      }}
                    >
                      ×
                    </span>
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      <div
        className="flex flex-col gap-2"
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(e) => {
          e.preventDefault();
          void handleBgFiles(e.dataTransfer.files);
        }}
      >
        <div className="flex items-center justify-between">
          <Label>Background</Label>
          <div className="flex items-center gap-2">
            {backgroundKind === "image" && backgroundImageId ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px] text-muted-foreground hover:text-destructive"
                onClick={() => void onRemoveBackground()}
              >
                Remove
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={onPickBgFile}
            >
              {backgroundKind === "image" ? "Replace image" : "Choose image"}
            </Button>
            <input
              ref={bgInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                void handleBgFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
        </div>
        {bgError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11.5px] text-destructive">
            {bgError}
          </div>
        ) : null}
        {backgroundKind === "image" && backgroundImageId ? (
          <div className="flex flex-col gap-3 rounded-lg border border-border/60 p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11.5px] text-muted-foreground">
                Opacity
              </span>
              <span className="tabular-nums text-[11px] text-muted-foreground">
                {Math.round(backgroundOpacity * 100)}%
              </span>
            </div>
            <Slider
              value={[backgroundOpacity]}
              min={0}
              max={1}
              step={0.01}
              onValueChange={(v) => void setBackgroundOpacity(v[0] ?? 0)}
            />
            <div className="flex items-center justify-between gap-3 pt-1">
              <span className="text-[11.5px] text-muted-foreground">Blur</span>
              <span className="tabular-nums text-[11px] text-muted-foreground">
                {backgroundBlur}px
              </span>
            </div>
            <Slider
              value={[backgroundBlur]}
              min={0}
              max={64}
              step={1}
              onValueChange={(v) => void setBackgroundBlur(v[0] ?? 0)}
            />
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Drop an image here or pick one. Stored locally; doesn't affect the
            default look until set.
          </p>
        )}
      </div>

      <ThemeJsonEditor
        theme={editing}
        onClose={() => setEditing(null)}
        onSaved={(newId) => {
          setEditing(null);
          setThemeId(newId);
        }}
      />
    </div>
  );
}

function ThemeJsonEditor({
  theme,
  onClose,
  onSaved,
}: {
  theme: Theme | null;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const lastThemeIdRef = useRef<string | null>(null);

  if (theme && lastThemeIdRef.current !== theme.id) {
    lastThemeIdRef.current = theme.id;
    setText(JSON.stringify(theme, null, 2));
    setError(null);
  }

  const extensions = useMemo(
    () => [json(), color, EditorView.lineWrapping],
    [],
  );

  const onSave = async () => {
    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setError(e instanceof Error ? e.message : "invalid JSON");
      return;
    }
    const result = validateTheme(parsed);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const oldId = theme?.id;
    await saveCustomTheme(result.theme);
    if (oldId && oldId !== result.theme.id) {
      await deleteCustomTheme(oldId);
    }
    onSaved(result.theme.id);
  };

  return (
    <Dialog open={!!theme} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit theme</DialogTitle>
        </DialogHeader>
        <div className="rounded-md border border-border/60 bg-background">
          <CodeMirror
            value={text}
            height="420px"
            extensions={extensions}
            onChange={(v) => setText(v)}
            basicSetup={{
              lineNumbers: true,
              foldGutter: true,
              highlightActiveLine: true,
              indentOnInput: true,
              bracketMatching: true,
              closeBrackets: true,
            }}
          />
        </div>
        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11.5px] text-destructive">
            {error}
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void onSave()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}
