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
    status: async ({ environmentId }) => {
      const { hostId, root } = await resolve(environmentId);
      return host.call("status", { root }, { hostId, timeoutMs: READ_TIMEOUT_MS });
    },
    search: async ({ environmentId, query }) => {
      const { hostId, root } = await resolve(environmentId);
      return host.call("search", { root, query }, { hostId, timeoutMs: READ_TIMEOUT_MS });
    },
    diff: async ({ environmentId, path, staged, untracked }) => {
      const { hostId, root } = await resolve(environmentId);
      return host.call("diff", { root, path, staged, untracked }, { hostId, timeoutMs: READ_TIMEOUT_MS });
    },
    stage: mutation(({ hostId, root }, { paths }) =>
      host.call("stage", { root, paths }, { hostId, timeoutMs: WRITE_TIMEOUT_MS }),
    ),
    unstage: mutation(({ hostId, root }, { paths }) =>
      host.call("unstage", { root, paths }, { hostId, timeoutMs: WRITE_TIMEOUT_MS }),
    ),
    discard: mutation(({ hostId, root }, { tracked, untracked }) =>
      host.call("discard", { root, tracked, untracked }, { hostId, timeoutMs: WRITE_TIMEOUT_MS }),
    ),
    commit: mutation(({ hostId, root }, { message, stageAll }) =>
      host.call("commit", { root, message, stageAll }, { hostId, timeoutMs: WRITE_TIMEOUT_MS }),
    ),
    push: mutation(({ hostId, root }) =>
      host.call("push", { root }, { hostId, timeoutMs: NETWORK_TIMEOUT_MS }),
    ),
    pull: mutation(({ hostId, root }) =>
      host.call("pull", { root }, { hostId, timeoutMs: NETWORK_TIMEOUT_MS }),
    ),
  });

  const usage = [
    "Usage:",
    "  bb treehouse status <environment-id> [--json]",
    "  bb treehouse ls <environment-id> [dir] [--json]",
  ].join("\n");

  bb.cli.register({
    name: "treehouse",
    summary: "Read an environment's file tree and git changes as Treehouse shows them",
    commands: [
      {
        name: "status",
        summary: "Show branch, ahead/behind and changed files",
        usage: "bb treehouse status <environment-id> [--json]",
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
        const result = await host.call("status", { root }, { hostId, timeoutMs: READ_TIMEOUT_MS });
        if (json) return { exitCode: 0, stdout: JSON.stringify(result) };
        if (!result.repo) return { exitCode: 0, stdout: "Not a git repository." };
        const lines = [
          `${result.branch ?? "(detached)"}${result.upstream === null ? "" : ` -> ${result.upstream}`} ↑${result.ahead} ↓${result.behind}`,
          ...result.files.map(
            (f) =>
              `${f.x}${f.y} ${f.path}${f.add === null ? "" : ` +${f.add}`}${f.del === null || f.del === 0 ? "" : ` -${f.del}`}`,
          ),
        ];
        if (result.truncated) lines.push("(truncated)");
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
