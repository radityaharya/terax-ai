import { tool } from "ai";
import { z } from "zod";
import { native, sshHostId } from "../lib/native";
import type { ToolContext } from "./context";

function requireSsh() {
  const hostId = sshHostId();
  return hostId ? null : { error: "Docker tools need an SSH host tab. Open a host tab first." };
}

/**
 * Docker tools for the agent. Read-only tools auto-execute; every
 * mutation asks for approval. All routes run on the active tab's host.
 */
export function buildDockerTools(_ctx: ToolContext) {
  return {
    docker_ps: tool({
      description:
        "List Docker containers on the active SSH host (`docker ps -a`). Auto-executes.",
      inputSchema: z.object({}),
      execute: async () => {
        const gate = requireSsh();
        if (gate) return gate;
        try {
          const containers = await native.docker.ps(true);
          return { containers };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    docker_images: tool({
      description: "List Docker images on the active SSH host. Auto-executes.",
      inputSchema: z.object({}),
      execute: async () => {
        const gate = requireSsh();
        if (gate) return gate;
        try {
          const images = await native.docker.images();
          return { images };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    docker_inspect: tool({
      description:
        "Structured `docker inspect` for a container/image/volume/network/service on the active SSH host. Auto-executes.",
      inputSchema: z.object({
        kind: z.enum(["container", "image", "volume", "network", "service"]),
        id: z.string(),
      }),
      execute: async ({ kind, id }) => {
        const gate = requireSsh();
        if (gate) return gate;
        try {
          const data = await native.docker.inspect(kind, id);
          return { data };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    docker_logs: tool({
      description:
        "Tail logs for a container or service on the active SSH host (one-shot, last 200 lines). Auto-executes.",
      inputSchema: z.object({
        container: z.string(),
        tail: z.number().int().min(1).max(1000).optional(),
      }),
      execute: async ({ container, tail }) => {
        const gate = requireSsh();
        if (gate) return gate;
        try {
          const r = await native.docker.logs(container, tail ?? 200);
          return r;
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    docker_pull: tool({
      description:
        "Pull an image reference on the active SSH host. Returns server output. Asks for user approval.",
      inputSchema: z.object({ reference: z.string() }),
      needsApproval: true,
      execute: async ({ reference }) => {
        const gate = requireSsh();
        if (gate) return gate;
        try {
          const output = await native.docker.pull(reference);
          return { reference, output };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    docker_lifecycle: tool({
      description:
        "Start/stop/restart/kill/remove containers on the active SSH host. Removing is force. Asks for user approval.",
      inputSchema: z.object({
        action: z.enum(["start", "stop", "restart", "kill", "rm"]),
        ids: z.array(z.string()).min(1),
      }),
      needsApproval: true,
      execute: async ({ action, ids }) => {
        const gate = requireSsh();
        if (gate) return gate;
        try {
          const output = await native.docker.lifecycle(action, ids);
          return { action, ids, output };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    docker_diagnose: tool({
      description:
        "Diagnose a container on the active SSH host: fetches inspect + recent logs + exit/health state and returns a root-cause summary. Auto-executes the reads.",
      inputSchema: z.object({ container: z.string() }),
      execute: async ({ container }) => {
        const gate = requireSsh();
        if (gate) return gate;
        try {
          const [inspect, logs] = await Promise.all([
            native.docker.inspect("container", container),
            native.docker.logs(container, 200),
          ]);
          const rec = (Array.isArray(inspect) ? inspect[0] : inspect) as Record<string, unknown>;
          const state = (rec?.State ?? {}) as Record<string, unknown>;
          const summary = {
            container,
            running: state.Running === true,
            exitCode: state.ExitCode,
            oomKilled: state.OOMKilled,
            error: state.Error,
            health: (state.Health as Record<string, unknown> | undefined)?.Status,
            restartCount: state.RestartCount ?? (rec?.RestartCount as unknown),
            image: (rec?.Config as Record<string, unknown> | undefined)?.Image ?? rec?.Image,
          };
          return { summary, recentLogs: (logs as { output?: string }).output ?? logs };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),
  } as const;
}
