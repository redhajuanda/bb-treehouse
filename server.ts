import { experimental_PluginRpcRefusal, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { CHANGED_CHANNEL, hostContract, hostSignals, rpcContract } from "./contract.js";

const READ_TIMEOUT_MS = 20_000;
const WRITE_TIMEOUT_MS = 120_000;
const NETWORK_TIMEOUT_MS = 300_000;
const ENV_CACHE_MS = 30_000;

interface Target {
  hostId: string;
  root: string;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    anthropicApiKey: {
      type: "string",
      label: "Anthropic API key",
      description:
        "Used for ✨ commit messages (Claude Opus 5.5). Leave empty to use the server's ANTHROPIC_API_KEY or `ant auth login` profile, or the `claude` CLI on the workspace machine.",
      secret: true,
      default: "",
    },
  });
  const { anthropicApiKey } = await settings.get();

  const host = bb.hosts.experimental_client({ contract: hostContract, experimental_signals: hostSignals });
  const watchers = new Map<string, Set<string>>();
  const watchKey = (hostId: string, root: string) => `${hostId}\u0000${path.resolve(root)}`;
  const stopSignals = host.experimental_onSignal("changed", ({ hostId, payload }) => {
    for (const environmentId of watchers.get(watchKey(hostId, payload.root)) ?? []) {
      bb.realtime.publish(CHANGED_CHANNEL, { environmentId });
    }
  });
  const stopExits = host.experimental_onWorkerExit(({ hostId }) => {
    for (const key of [...watchers.keys()]) if (key.startsWith(`${hostId}\u0000`)) watchers.delete(key);
  });
  bb.onDispose(() => {
    stopSignals();
    stopExits();
    watchers.clear();
  });
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

  function mutation<I extends { environmentId: string }, O>(run: (target: Target, input: I) => Promise<O>) {
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
    search: async ({ environmentId, ...input }) => {
      const { hostId, root } = await resolve(environmentId);
      return host.call("search", { root, ...input }, { hostId, timeoutMs: READ_TIMEOUT_MS });
    },
    diff: async ({ environmentId, ...input }) => {
      const { hostId, root } = await resolve(environmentId);
      return host.call("diff", { root, ...input }, { hostId, timeoutMs: READ_TIMEOUT_MS });
    },
    watch: async ({ environmentId }) => {
      const { hostId, root } = await resolve(environmentId);
      const result = await host.call("watch", { root }, { hostId, timeoutMs: READ_TIMEOUT_MS });
      const key = watchKey(hostId, root);
      const set = watchers.get(key) ?? new Set<string>();
      set.add(environmentId);
      watchers.set(key, set);
      return result;
    },
    branches: async ({ environmentId, ...input }) => {
      const { hostId, root } = await resolve(environmentId);
      return host.call("branches", { root, ...input }, { hostId, timeoutMs: READ_TIMEOUT_MS });
    },
    compare: async ({ environmentId, ...input }) => {
      const { hostId, root } = await resolve(environmentId);
      return host.call("compare", { root, ...input }, { hostId, timeoutMs: READ_TIMEOUT_MS });
    },
    compareDiff: async ({ environmentId, ...input }) => {
      const { hostId, root } = await resolve(environmentId);
      return host.call("compareDiff", { root, ...input }, { hostId, timeoutMs: READ_TIMEOUT_MS });
    },
    applyHunk: mutation(({ hostId, root }, { environmentId: _, ...input }) =>
      host.call("applyHunk", { root, ...input }, { hostId, timeoutMs: WRITE_TIMEOUT_MS }),
    ),
    createPr: mutation(({ hostId, root }, { environmentId: _, ...input }) =>
      host.call("createPr", { root, ...input }, { hostId, timeoutMs: NETWORK_TIMEOUT_MS }),
    ),
    commitContext: async ({ environmentId, ...input }) => {
      const { hostId, root } = await resolve(environmentId);
      return host.call("commitContext", { root, ...input }, { hostId, timeoutMs: READ_TIMEOUT_MS });
    },
    suggestMessage: async ({ environmentId, repo }) => {
      const { hostId, root } = await resolve(environmentId);
      const context = await host.call("commitContext", { root, repo }, { hostId, timeoutMs: READ_TIMEOUT_MS });
      if (context.stat === "" && context.patch === "") {
        throw new experimental_PluginRpcRefusal({ code: "conflict", message: "There are no changes to describe." });
      }
      const prompt = commitPrompt(context);
      const viaApi = await completeWithApi(anthropicApiKey, prompt);
      if (viaApi !== null) return { message: cleanMessage(viaApi), source: "api" as const };
      const repoRoot = repo === "" ? root : path.join(root, repo);
      const viaCli = await host.call("claudeCli", { root: repoRoot, prompt }, { hostId, timeoutMs: 120_000 });
      if (!viaCli.available) {
        throw new experimental_PluginRpcRefusal({
          code: "conflict",
          message:
            "No Claude access found. Add an Anthropic API key in Treehouse's settings, sign in with `ant auth login`, or install the `claude` CLI.",
        });
      }
      return { message: cleanMessage(viaCli.text), source: "cli" as const };
    },
    log: async ({ environmentId, ...input }) => {
      const { hostId, root } = await resolve(environmentId);
      return host.call("log", { root, ...input }, { hostId, timeoutMs: READ_TIMEOUT_MS });
    },
    show: async ({ environmentId, ...input }) => {
      const { hostId, root } = await resolve(environmentId);
      return host.call("show", { root, ...input }, { hostId, timeoutMs: READ_TIMEOUT_MS });
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
        summary:
          "Show branch, ahead/behind and changed files for every git repository in the workspace, or under one folder",
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
        const result = await host.call(
          "workspaceStatus",
          { root, rescan: true },
          { hostId, timeoutMs: READ_TIMEOUT_MS },
        );
        const repos = result.repos.filter((r) => folder === "" || r.repo === folder || r.repo.startsWith(`${folder}/`));
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
        const result = await host.call("listDir", { root, rel: dir ?? "" }, { hostId, timeoutMs: READ_TIMEOUT_MS });
        if (json) return { exitCode: 0, stdout: JSON.stringify(result) };
        return {
          exitCode: 0,
          stdout: result.entries.map((e) => `${e.name}${e.dir ? "/" : ""}${e.ignored ? "  (ignored)" : ""}`).join("\n"),
        };
      }
      return { exitCode: 1, stderr: usage };
    },
  });
}

interface CommitContext {
  stagedOnly: boolean;
  stat: string;
  patch: string;
  truncated: boolean;
  recent: string[];
  branch: string | null;
}

function commitPrompt(context: CommitContext): string {
  return [
    "Write a git commit message for the changes below.",
    "",
    "Rules:",
    "- First line: an imperative summary of at most 72 characters.",
    "- If the change needs explanation, add a blank line and a short body wrapped at 72 characters; otherwise write only the summary.",
    "- Follow the style of the repository's recent commit subjects (for example a conventional-commit prefix) when they use one.",
    "- Output only the commit message, with no quotes, code fences or commentary.",
    "",
    `Branch: ${context.branch ?? "(detached)"}`,
    `Scope: ${context.stagedOnly ? "staged changes only" : "all uncommitted changes"}`,
    "",
    "Recent commit subjects:",
    ...(context.recent.length === 0 ? ["(none)"] : context.recent.map((subject) => `- ${subject}`)),
    "",
    "Diffstat:",
    context.stat === "" ? "(none)" : context.stat,
    "",
    context.truncated ? "Diff (cut off at 120 KB; the diffstat above lists every file):" : "Diff:",
    context.patch,
  ].join("\n");
}

function cleanMessage(text: string): string {
  return text
    .trim()
    .replace(/^```[a-z]*\n?/u, "")
    .replace(/\n?```$/u, "")
    .trim();
}

async function completeWithApi(apiKey: string, prompt: string): Promise<string | null> {
  let client: Anthropic;
  try {
    client = apiKey === "" ? new Anthropic() : new Anthropic({ apiKey });
  } catch {
    return null;
  }
  try {
    const response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 2048,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{ role: "user", content: prompt }],
    });
    if (response.stop_reason === "refusal") {
      throw new experimental_PluginRpcRefusal({
        code: "conflict",
        message: "Claude declined to write a message for these changes.",
      });
    }
    const text = response.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("")
      .trim();
    return text === "" ? null : text;
  } catch (error) {
    if (error instanceof experimental_PluginRpcRefusal) throw error;
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) return null;
    if (error instanceof Anthropic.APIError && error.status !== undefined) throw error;
    return null;
  }
}
