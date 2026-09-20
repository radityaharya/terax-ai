export type SshHost = {
  id: string;
  alias: string;
  user: string;
  hostname: string;
  port: number;
  identityFile?: string | null;
  remoteRoot?: string | null;
  boundSpaceId?: string | null;
  /** `#rrggbb` accent. `null`/absent means "auto" — a stable color derived
   *  from the host id (see `resolveHostColor`). */
  color?: string | null;
  agentForward: boolean;
  createdAtMs: number;
  updatedAtMs: number;
};

export type SshHostInput = {
  id?: string | null;
  alias: string;
  user: string;
  hostname: string;
  port?: number | null;
  identityFile?: string | null;
  remoteRoot?: string | null;
  color?: string | null;
  agentForward?: boolean | null;
};

export type ImportedHost = {
  alias: string;
  hostname?: string | null;
  user?: string | null;
  port?: number | null;
  identityFile?: string | null;
};

export type ProbeOutcome = {
  ok: boolean;
  message?: string | null;
  /** Suggested next auth step: key | password | terminal-2fa */
  next?: string | null;
};

export type HostKeyStatus = {
  known: boolean;
  lines: string[];
};

export type ScannedKey = {
  keyType: string;
  keyData: string;
  fingerprint: string;
};
