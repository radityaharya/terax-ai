import type {
  GitCommitFileDiffTab,
  GitDiffTab,
  Tab,
} from "@/modules/tabs";
import { GitDiffPane } from "./GitDiffPane";

type Props = {
  tabs: Tab[];
  activeId: number;
};

export function GitDiffStack({ tabs, activeId }: Props) {
  const active = tabs.find(
    (t): t is GitDiffTab | GitCommitFileDiffTab =>
      (t.kind === "git-diff" || t.kind === "git-commit-file") &&
      t.id === activeId,
  );
  if (!active) return null;
  if (active.kind === "git-diff") {
    return (
      <div className="h-full w-full">
        <GitDiffPane
          key={active.id}
          path={active.path}
          repoRoot={active.repoRoot}
          mode={active.mode}
          originalContent={active.originalContent}
          modifiedContent={active.modifiedContent}
          isBinary={active.isBinary}
          fallbackPatch={active.fallbackPatch}
        />
      </div>
    );
  }
  return (
    <div className="h-full w-full">
      <GitDiffPane
        key={active.id}
        path={active.path}
        repoRoot={active.repoRoot}
        mode="+"
        originalContent={active.originalContent}
        modifiedContent={active.modifiedContent}
        isBinary={active.isBinary}
        fallbackPatch={active.fallbackPatch}
        chipLabel={active.shortSha}
      />
    </div>
  );
}
