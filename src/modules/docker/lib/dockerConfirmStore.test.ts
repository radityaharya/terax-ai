import { beforeEach, describe, expect, it } from "vitest";
import {
  confirmDockerAction,
  useDockerConfirmStore,
} from "./dockerConfirmStore";

describe("dockerConfirmStore", () => {
  beforeEach(() => {
    useDockerConfirmStore.setState({ pending: null });
  });

  it("queues a confirmation request with resource metadata", async () => {
    const promise = confirmDockerAction({
      title: "Restart container",
      actionLabel: "Restart",
      actionVariant: "warning",
      resourceKind: "Container",
      resourceName: "web-prod",
      resourceDetails: "ID: abc12345 · Image: nginx:alpine",
      hostAlias: "staging-server",
      description: "Restarts the running container process.",
    });

    const pending = useDockerConfirmStore.getState().pending;
    expect(pending).not.toBeNull();
    expect(pending?.title).toBe("Restart container");
    expect(pending?.actionLabel).toBe("Restart");
    expect(pending?.actionVariant).toBe("warning");
    expect(pending?.resourceKind).toBe("Container");
    expect(pending?.resourceName).toBe("web-prod");
    expect(pending?.resourceDetails).toBe("ID: abc12345 · Image: nginx:alpine");
    expect(pending?.hostAlias).toBe("staging-server");
    expect(pending?.description).toBe("Restarts the running container process.");

    useDockerConfirmStore.getState().confirm();
    const result = await promise;
    expect(result).toBe(true);
    expect(useDockerConfirmStore.getState().pending).toBeNull();
  });

  it("resolves to false when cancelled", async () => {
    const promise = confirmDockerAction({
      title: "Kill container",
      actionLabel: "Kill",
      actionVariant: "destructive",
      resourceKind: "Container",
      resourceName: "api-worker",
    });

    expect(useDockerConfirmStore.getState().pending).not.toBeNull();
    useDockerConfirmStore.getState().cancel();

    const result = await promise;
    expect(result).toBe(false);
    expect(useDockerConfirmStore.getState().pending).toBeNull();
  });

  it("cancels an existing pending request when a new request arrives", async () => {
    const firstPromise = confirmDockerAction({
      title: "Action 1",
      actionLabel: "Do 1",
      resourceKind: "Volume",
      resourceName: "vol-1",
    });

    const secondPromise = confirmDockerAction({
      title: "Action 2",
      actionLabel: "Do 2",
      resourceKind: "Network",
      resourceName: "net-2",
    });

    // First request should automatically resolve to false
    const firstResult = await firstPromise;
    expect(firstResult).toBe(false);

    // Second request is now the active pending
    expect(useDockerConfirmStore.getState().pending?.resourceName).toBe("net-2");

    useDockerConfirmStore.getState().confirm();
    const secondResult = await secondPromise;
    expect(secondResult).toBe(true);
  });
});
