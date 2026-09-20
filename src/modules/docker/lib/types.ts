/** Docker panel is host-scoped to the active tab (v1: SSH hosts only). */

export type DockerDaemonState =
  | { status: "unknown" }
  | { status: "checking" }
  | { status: "ready"; capabilities: DockerCapabilities }
  | { status: "not-installed"; message: string }
  | { status: "daemon-down"; message: string }
  | { status: "permission-denied"; message: string }
  | { status: "offline"; message: string };

export type DockerCapabilities = {
  installed: boolean;
  clientVersion: string;
  serverVersion: string;
  daemonRunning: boolean;
  permissionDenied: boolean;
  composeV2: boolean;
  composeV1: boolean;
  swarmState: string;
  rootless: boolean;
  context: string;
};

export type DockerContainer = {
  ID?: string;
  Id?: string;
  Names?: string;
  Name?: string;
  Image?: string;
  State?: string;
  Status?: string;
  Ports?: string;
  CreatedAt?: string;
  Labels?: string;
  Mounts?: string;
  Networks?: string;
  [key: string]: unknown;
};

export type DockerImage = {
  ID?: string;
  Repository?: string;
  Tag?: string;
  Digest?: string;
  CreatedAt?: string;
  Size?: string;
  [key: string]: unknown;
};

export type DockerVolume = {
  Name?: string;
  Driver?: string;
  Scope?: string;
  Mountpoint?: string;
  [key: string]: unknown;
};

export type DockerNetwork = {
  ID?: string;
  Name?: string;
  Driver?: string;
  Scope?: string;
  [key: string]: unknown;
};

export type DockerResourceKind =
  | "containers"
  | "images"
  | "volumes"
  | "networks";

export type ResourceListState<T> = {
  items: T[];
  loading: boolean;
  error: string | null;
  updatedAt: number | null;
};

export type PullProgressEvent =
  | { kind: "layer"; id: string; status: string; detail: string }
  | { kind: "status"; text: string }
  | { kind: "digest"; digest: string }
  | { kind: "done"; reference: string }
  | { kind: "error"; text: string }
  | { kind: "raw"; text: string };
