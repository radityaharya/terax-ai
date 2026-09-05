import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { BlockOverlay } from "@/modules/terminal/block/BlockOverlay";
import { BlockWatermark } from "@/modules/terminal/block/BlockWatermark";
import { ensureGhosttyBlocks } from "@/modules/terminal/ghostty/ghosttyBlockSessions";
import { ghosttyBlockGeometry } from "@/modules/terminal/ghostty/useGhosttyTerminalSession";
import {
  focusLeafInput,
  submitToLeaf,
} from "@/modules/terminal/lib/terminalSessionApi";
import { subscribeWindowPresentation } from "@/modules/terminal/ghostty/windowPresentation";
import type { GhosttyBlockSession } from "@/modules/terminal/ghostty/ghosttyBlockSessions";

export default function GhosttyBlockOverlay({
  leafId,
  visible,
}: {
  leafId: number;
  visible: boolean;
}) {
  const state = ensureGhosttyBlocks(leafId);
  const mode = useSyncExternalStore(state.subscribeMode, state.getMode);
  const getVisible = useCallback(
    () =>
      state.controller?.visibleBlocks(
        ghosttyBlockGeometry(leafId)?.height ?? 0,
      ) ?? { blocks: [], sticky: null },
    [leafId, state],
  );
  return (
    <>
      <BlockRuler state={state} visible={visible} />
      <BlockWatermark leafId={leafId} subscribe={state.subscribeViewport} />
      <BlockOverlay
        subscribe={state.subscribeViewport}
        getVisible={getVisible}
        readOutput={(id) => state.controller?.readById(id)?.output ?? null}
        searchBlock={(id, query) =>
          state.controller?.searchBlock(id, query) ?? []
        }
        revealMatch={(match) => state.controller?.revealMatch(match)}
        clearSearch={() => state.controller?.clearSearch()}
        promptReady={mode === "prompt"}
        onRunAgain={(command) => submitToLeaf(leafId, command)}
        onRestoreFocus={() => {
          if (state.getMode() === "prompt") focusLeafInput(leafId);
        }}
      />
    </>
  );
}

function BlockRuler({
  state,
  visible,
}: {
  state: GhosttyBlockSession;
  visible: boolean;
}) {
  const [paths, setPaths] = useState({ ok: "", failed: "" });
  useEffect(() => {
    if (!visible) return;
    let presented = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const update = () => {
      timer = null;
      if (!presented || state.model?.isDisposed?.()) return;
      const rows = state.controller?.overviewRows();
      let ok = "";
      let failed = "";
      if (rows)
        for (let row = 0; row < rows.length; row++) {
          const mark = `M0 ${row}h1v1H0z`;
          if (rows[row] === 1) ok += mark;
          else if (rows[row] === 2) failed += mark;
        }
      setPaths((previous) =>
        previous.ok === ok && previous.failed === failed
          ? previous
          : { ok, failed },
      );
    };
    const schedule = () => {
      if (presented && timer === null) timer = setTimeout(update, 250);
    };
    const unlisten = subscribeWindowPresentation((next) => {
      presented = next.visible;
      if (presented) schedule();
      else if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    });
    const unsubscribe = state.subscribeViewport(schedule);
    return () => {
      unlisten();
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, [state, visible]);
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 1 256"
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-y-0 right-0 z-10 h-full w-[3px]"
    >
      <path d={paths.ok} fill="#5fb3b3" />
      <path d={paths.failed} fill="#e5706b" />
    </svg>
  );
}
