import { create } from "zustand";

export type DockerResourceKind =
  | "Container"
  | "Compose Project"
  | "Swarm Service"
  | "Swarm Node"
  | "Swarm Stack"
  | "Volume"
  | "Network"
  | "Image"
  | "Swarm Cluster"
  | "Secret"
  | "Config"
  | "System Prune"
  | "Registry";

export type DockerConfirmOptions = {
  /** Title for the confirmation dialog (e.g. "Restart container", "Kill container"). */
  title: string;
  /** Label for the confirming action button (e.g. "Restart", "Kill", "Remove", "Stop"). */
  actionLabel: string;
  /** Visual intent for the confirming button. Default is "default". */
  actionVariant?: "destructive" | "default" | "warning";
  /** The type of Docker entity being manipulated (e.g. "Container", "Compose Project"). */
  resourceKind: DockerResourceKind | string;
  /** The primary display name or reference of the entity (e.g. "my-app-web", "redis-data"). */
  resourceName: string;
  /** Optional secondary details (e.g. "ID: a1b2c3d4", "Image: redis:7-alpine", "3 service(s)"). */
  resourceDetails?: string;
  /** Remote host alias or ID if applicable. */
  hostAlias?: string;
  /** Explanation of what will happen when confirmed. */
  description?: string;
  /** Optional explicit warning note (highlighted). */
  warning?: string;
};

export type PendingDockerConfirm = DockerConfirmOptions & {
  resolve: (value: boolean) => void;
};

type DockerConfirmState = {
  pending: PendingDockerConfirm | null;
  request: (options: DockerConfirmOptions) => Promise<boolean>;
  confirm: () => void;
  cancel: () => void;
};

export const useDockerConfirmStore = create<DockerConfirmState>((set, get) => ({
  pending: null,
  request: (options) => {
    // If an existing request is pending when a new one arrives, resolve the old one as cancelled.
    get().pending?.resolve(false);
    return new Promise<boolean>((resolve) => {
      set({ pending: { ...options, resolve } });
    });
  },
  confirm: () => {
    const pending = get().pending;
    if (pending) {
      pending.resolve(true);
      set({ pending: null });
    }
  },
  cancel: () => {
    const pending = get().pending;
    if (pending) {
      pending.resolve(false);
      set({ pending: null });
    }
  },
}));

/**
 * Opens a modal confirmation dialog displaying the targeted Docker resource
 * and returns a promise resolving to true if the user confirms, or false if cancelled.
 */
export function confirmDockerAction(
  options: DockerConfirmOptions,
): Promise<boolean> {
  return useDockerConfirmStore.getState().request(options);
}
