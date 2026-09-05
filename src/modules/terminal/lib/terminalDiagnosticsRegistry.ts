let xtermDiagnostics: (() => Record<string, unknown>) | null = null;

export function registerXtermDiagnostics(
  provider: () => Record<string, unknown>,
): void {
  xtermDiagnostics = provider;
}

export function readXtermDiagnostics(): Record<string, unknown> | null {
  return xtermDiagnostics?.() ?? null;
}

export function terminalDiagnosticsEnabled(): boolean {
  if (typeof window === "undefined") return false;
  if (import.meta.env.DEV) return true;
  try {
    return window.localStorage.getItem("terax:terminal-diagnostics") === "1";
  } catch {
    return false;
  }
}
