import { currentWorkspaceEnv } from "@/modules/workspace";
import { sshHostId, sshRpc } from "@/modules/ai/lib/native";
import { invoke } from "@tauri-apps/api/core";
import { useCallback } from "react";
import { type AsyncQueryState, useAsyncQuery } from "./useAsyncQuery";

export const CONTENT_SEARCH_MIN_QUERY = 2;
const LIMIT = 80;
const DEBOUNCE_MS = 140;

export type ContentHit = {
  path: string;
  rel: string;
  line: number;
  text: string;
};

type GrepResponse = {
  hits: ContentHit[];
  truncated: boolean;
  files_scanned: number;
};

export function useContentSearch(
  root: string | null,
  term: string,
  enabled: boolean,
): AsyncQueryState<ContentHit> {
  const run = useCallback(
    async (q: string): Promise<ContentHit[]> => {
      if (!root) return [];
      // The remote agent serves fs_grep (regex); the literal interactive
      // variant stays local-only until the agent gains generation tracking.
      const res = sshHostId()
        ? await sshRpc<GrepResponse>("fs_grep", {
            pattern: q,
            root,
            maxResults: LIMIT,
          })
        : await invoke<GrepResponse>("fs_grep_interactive", {
            pattern: q,
            root,
            maxResults: LIMIT,
            workspace: currentWorkspaceEnv(),
          });
      return res.hits;
    },
    [root],
  );

  return useAsyncQuery({
    enabled: enabled && !!root,
    term,
    minLength: CONTENT_SEARCH_MIN_QUERY,
    debounceMs: DEBOUNCE_MS,
    run,
  });
}
