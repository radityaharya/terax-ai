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
  /** Pinned iroh EndpointId (64 hex chars) for the P2P fallback transport.
   *  `null`/absent means no fallback armed: connections only ever try SSH. */
  irohEndpointId?: string | null;
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

/** Result of the combined `ssh_probe_host` command: auth + remote facts
 *  (home, login shell, agent version) resolved in one ssh handshake. */
export type HostProbe = {
  ok: boolean;
  home?: string | null;
  message?: string | null;
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

/** Result of `iroh_setup_host`: the host's iroh identity, ready to show in
 *  a TOFU-style confirmation dialog before `iroh_confirm_pin` writes it. */
export type IrohBootstrapResult = {
  endpointId: string;
  fingerprint: string;
  alreadyPinned: boolean;
};
