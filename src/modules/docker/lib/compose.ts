/**
 * Pure helpers for compose project discovery. Kept out of the panel so they
 * are unit-testable and shared between the folder section and the card.
 */

/** dirname for a POSIX remote path (no trailing slash, root-safe). */
export function posixDirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

/** Compose's default project name: directory basename, lowercased and
 *  stripped to the characters compose itself allows in a project name. */
export function composeProjectName(dir: string): string {
  const base = dir.replace(/\/+$/, "").split("/").pop() ?? "compose";
  return base.toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

/**
 * Does a project belong to `cwd`? The registered working dir wins; older
 * projects (or ones started outside Terax) may only have the config file
 * paths, so the file's dirname is the fallback.
 */
export function projectInFolder(
  project: { projectDir: string; files: string[] },
  cwd: string | null | undefined,
): boolean {
  if (!cwd) return false;
  const norm = cwd.replace(/\/+$/, "");
  if (project.projectDir && project.projectDir.replace(/\/+$/, "") === norm) {
    return true;
  }
  return project.files.some((f) => posixDirname(f) === norm);
}
