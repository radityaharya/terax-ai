import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { unifiedMergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { useEffect, useMemo, useRef } from "react";
import { buildSharedExtensions, languageCompartment } from "./lib/extensions";
import { resolveLanguage, resolveLanguageSync } from "./lib/languageResolver";
import { EDITOR_THEME_EXT } from "./lib/themes";

type Props = {
  path: string;
  repoRoot: string;
  mode: "-" | "+";
  originalContent: string;
  modifiedContent: string;
  isBinary: boolean;
  fallbackPatch: string;
  chipLabel?: string;
};

const LARGE_FILE_THRESHOLD = 256 * 1024;

const SHARED_EXT = buildSharedExtensions();
const READONLY_EXT = [
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
];
const DIFF_THEME = EditorView.theme({
  ".cm-changedText": {
    background: "#88ff881a !important",
  },
});

function countDiffLines(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (let i = 0; i < patch.length; i++) {
    if (i > 0 && patch.charCodeAt(i - 1) !== 10) continue;
    const c = patch.charCodeAt(i);
    if (c === 43 && patch.charCodeAt(i + 1) !== 43) added++;
    else if (c === 45 && patch.charCodeAt(i + 1) !== 45) removed++;
  }
  if (patch.length > 0 && patch.charCodeAt(0) === 43) added++;
  else if (patch.length > 0 && patch.charCodeAt(0) === 45) removed++;
  return { added, removed };
}

export function GitDiffPane({
  path,
  repoRoot,
  mode,
  originalContent,
  modifiedContent,
  isBinary,
  fallbackPatch,
  chipLabel,
}: Props) {
  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const editorThemeId = usePreferencesStore((s) => s.editorTheme);
  const themeExt = EDITOR_THEME_EXT[editorThemeId] ?? EDITOR_THEME_EXT.atomone;

  const isTooLarge =
    originalContent.length > LARGE_FILE_THRESHOLD ||
    modifiedContent.length > LARGE_FILE_THRESHOLD;
  const useFallback = isBinary || isTooLarge;

  const initialLang = useMemo(() => resolveLanguageSync(path), [path]);
  const extensions = useMemo(
    () => [
      ...SHARED_EXT,
      languageCompartment.of(initialLang ?? []),
      ...READONLY_EXT,
      unifiedMergeView({
        original: originalContent,
        mergeControls: false,
        highlightChanges: true,
        gutter: true,
        syntaxHighlightDeletions: true,
        collapseUnchanged: { margin: 3, minSize: 6 },
      }),
      DIFF_THEME,
    ],
    [originalContent, initialLang],
  );

  useEffect(() => {
    if (useFallback || initialLang) return;
    let cancelled = false;
    resolveLanguage(path).then((ext) => {
      if (cancelled) return;
      const view = cmRef.current?.view;
      if (!view) return;
      view.dispatch({
        effects: languageCompartment.reconfigure(ext ?? []),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [useFallback, path, initialLang]);

  const stats = useMemo(
    () => countDiffLines(fallbackPatch),
    [fallbackPatch],
  );

  return (
    <div className="flex h-full min-h-0 flex-col rounded-md border border-border/60 bg-background">
      <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border/60 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge
            variant="outline"
            className="text-[10px] uppercase tracking-wide"
          >
            {chipLabel ?? mode}
          </Badge>
          {isBinary ? (
            <Badge variant="secondary" className="text-[10px]">
              Binary / patch fallback
            </Badge>
          ) : isTooLarge ? (
            <Badge variant="secondary" className="text-[10px]">
              Large file / patch view
            </Badge>
          ) : null}
          <span
            className="truncate font-mono text-[11px] text-muted-foreground"
            title={path}
          >
            {path}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-[10.5px] tabular-nums text-muted-foreground">
          <span className="truncate max-w-80 font-mono">{repoRoot}</span>
          <span className="text-emerald-600 dark:text-emerald-400">
            +{stats.added}
          </span>
          <span className="text-rose-600 dark:text-rose-400">
            −{stats.removed}
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {useFallback ? (
          <ScrollArea className="h-full">
            <pre className="min-h-full whitespace-pre-wrap wrap-break-word p-4 font-mono text-[12px] leading-relaxed text-muted-foreground">
              {fallbackPatch ||
                "Diff preview is not available for this file."}
            </pre>
          </ScrollArea>
        ) : (
          <CodeMirror
            ref={cmRef}
            value={modifiedContent}
            theme={themeExt}
            extensions={extensions}
            editable={false}
            height="100%"
            className="h-full"
            basicSetup={{
              lineNumbers: true,
              foldGutter: true,
              highlightActiveLine: false,
              highlightActiveLineGutter: false,
              searchKeymap: true,
            }}
          />
        )}
      </div>
    </div>
  );
}
