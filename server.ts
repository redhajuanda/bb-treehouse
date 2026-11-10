import {
  experimental_PluginRpcRefusal,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { CHANGED_CHANNEL, hostContract, rpcContract } from "./contract.js";

const READ_TIMEOUT_MS = 20_000;
const WRITE_TIMEOUT_MS = 120_000;
const NETWORK_TIMEOUT_MS = 300_000;
const ENV_CACHE_MS = 30_000;

interface Target {
  hostId: string;
  root: string;
}

export default async function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const targets = new Map<string, { at: number; target: Target }>();

  async function resolve(environmentId: string): Promise<Target> {
    const cached = targets.get(environmentId);
    if (cached !== undefined && Date.now() - cached.at < ENV_CACHE_MS) return cached.target;
    const environment = await bb.sdk.environments.get({ environmentId });
    if (environment.status !== "ready" || environment.path === null) {
      throw new experimental_PluginRpcRefusal({
        code: "conflict",
        message: "Workspace is not ready yet.",
      });
    }
    const target = { hostId: environment.hostId, root: environment.path };
    targets.set(environmentId, { at: Date.now(), target });
    return target;
  }

  async function changed(environmentId: string) {
    bb.realtime.publish(CHANGED_CHANNEL, { environmentId });
    await bb.sdk.plugins
      .callRpc({
        pluginId: "bb--git",
        method: "refresh",
        input: { environmentId },
        outputSchema: z.unknown(),
      })
      .catch((error: unknown) => bb.log.debug(`bb--git refresh failed: ${String(error)}`));
  }

  function mutation<I extends { environmentId: string }, O>(
    run: (target: Target, input: I) => Promise<O>,
  ) {
    return async (input: I) => {
      const target = await resolve(input.environmentId);
      try {
        return await run(target, input);
      } finally {
        await changed(input.environmentId);
      }
    };
  }

  bb.rpc.register(rpcContract, {
    listDir: async ({ environmentId, rel }) => {
      const { hostId, root } = await resolve(environmentId);
      return host.call("listDir", { root, rel }, { hostId, timeoutMs: READ_TIMEOUT_MS });
    },
    workspaceStatus: async ({ environmentId, rescan }) => {
      const { hostId, root } = await resolve(environmentId);
      return host.call("workspaceStatus", { root, rescan }, { hostId, timeoutMs: READ_TIMEOUT_MS });
    },
    search: async ({ environmentId, query }) => {
      const { hostId, root } = await resolve(environmentId);
      return host.call("search", { root, query }, { hostId, timeoutMs: READ_TIMEOUT_MS });
    },
    diff: async ({ environmentId, ...input }) => {
      const { hostId, root } = await resolve(environmentId);
      return host.call("diff", { root, ...input }, { hostId, timeoutMs: READ_TIMEOUT_MS });
    },
    stage: mutation(({ hostId, root }, { environmentId: _, ...input }) =>
      host.call("stage", { root, ...input }, { hostId, timeoutMs: WRITE_TIMEOUT_MS }),
    ),
    unstage: mutation(({ hostId, root }, { environmentId: _, ...input }) =>
      host.call("unstage", { root, ...input }, { hostId, timeoutMs: WRITE_TIMEOUT_MS }),
    ),
    discard: mutation(({ hostId, root }, { environmentId: _, ...input }) =>
      host.call("discard", { root, ...input }, { hostId, timeoutMs: WRITE_TIMEOUT_MS }),
    ),
    commit: mutation(({ hostId, root }, { environmentId: _, ...input }) =>
      host.call("commit", { root, ...input }, { hostId, timeoutMs: WRITE_TIMEOUT_MS }),
    ),
    push: mutation(({ hostId, root }, { repo }) =>
      host.call("push", { root, repo }, { hostId, timeoutMs: NETWORK_TIMEOUT_MS }),
    ),
    pull: mutation(({ hostId, root }, { repo }) =>
      host.call("pull", { root, repo }, { hostId, timeoutMs: NETWORK_TIMEOUT_MS }),
    ),
  });

  const usage = [
    "Usage:",
    "  bb treehouse status <environment-id> [folder] [--json]",
    "  bb treehouse ls <environment-id> [dir] [--json]",
  ].join("\n");

  bb.cli.register({
    name: "treehouse",
    summary: "Read an environment's file tree and git changes as Treehouse shows them",
    commands: [
      {
        name: "status",
        summary: "Show branch, ahead/behind and changed files for every git repository in the workspace, or under one folder",
        usage: "bb treehouse status <environment-id> [folder] [--json]",
      },
      {
        name: "ls",
        summary: "List one directory of the workspace, marking ignored entries",
        usage: "bb treehouse ls <environment-id> [dir] [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const [command, environmentId, dir] = argv.filter((arg) => arg !== "--json");
      if (command === undefined || command === "help" || command === "--help") {
        return { exitCode: 0, stdout: usage };
      }
      if (environmentId === undefined) return { exitCode: 1, stderr: usage };
      const { hostId, root } = await resolve(environmentId);
      if (command === "status") {
        const folder = (dir ?? "").replace(/\/+$/u, "");
        const result = await host.call("workspaceStatus", { root, rescan: true }, { hostId, timeoutMs: READ_TIMEOUT_MS });
        const repos = result.repos.filter(
          (r) => folder === "" || r.repo === folder || r.repo.startsWith(`${folder}/`),
        );
        if (json) return { exitCode: 0, stdout: JSON.stringify({ ...result, repos }) };
        if (repos.length === 0) return { exitCode: 0, stdout: "No git repositories found." };
        const lines: string[] = [];
        for (const { repo, status } of repos) {
          if (!status.repo) continue;
          lines.push(
            `[${repo === "" ? "." : repo}] ${status.branch ?? "(detached)"}${status.upstream === null ? "" : ` -> ${status.upstream}`} ↑${status.ahead} ↓${status.behind}`,
            ...status.files.map(
              (f) =>
                `  ${f.x}${f.y} ${f.path}${f.add === null ? "" : ` +${f.add}`}${f.del === null || f.del === 0 ? "" : ` -${f.del}`}`,
            ),
          );
          if (status.truncated) lines.push("  (truncated)");
        }
        if (result.truncated) lines.push("(repository scan truncated)");
        return { exitCode: 0, stdout: lines.join("\n") };
      }
      if (command === "ls") {
        const result = await host.call(
          "listDir",
          { root, rel: dir ?? "" },
          { hostId, timeoutMs: READ_TIMEOUT_MS },
        );
        if (json) return { exitCode: 0, stdout: JSON.stringify(result) };
        return {
          exitCode: 0,
          stdout: result.entries
            .map((e) => `${e.name}${e.dir ? "/" : ""}${e.ignored ? "  (ignored)" : ""}`)
            .join("\n"),
        };
      }
      return { exitCode: 1, stderr: usage };
    },
  });
}
