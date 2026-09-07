export function homeRelativePath(path: string, home: string | null): string {
  const normalized = path.replace(/\\/g, "/");
  if (!home) return normalized;
  const root = home.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalized === root || normalized.startsWith(`${root}/`)) {
    return `~${normalized.slice(root.length)}`;
  }
  return normalized;
}
