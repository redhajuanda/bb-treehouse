import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const MAX_STATUS_FILES = 5000;
export const MAX_DIR_ENTRIES = 5000;
export const MAX_SEARCH_RESULTS = 200;
export const MAX_REPOS = 64;

const root = z.string().min(1);
const relPath = z.string().max(4096);
const pathList = z.array(z.string().min(1).max(4096)).min(1).max(MAX_STATUS_FILES);

export const dirEntrySchema = z.object({
  name: z.string(),
  dir: z.boolean(),
  ignored: z.boolean(),
});
export type DirEntry = z.infer<typeof dirEntrySchema>;

export const changeSchema = z.object({
  path: z.string(),
  orig: z.string().nullable(),
  x: z.string().length(1),
  y: z.string().length(1),
  add: z.number().int().nonnegative().nullable(),
  del: z.number().int().nonnegative().nullable(),
});
export type Change = z.infer<typeof changeSchema>;

export const statusSchema = z.discriminatedUnion("repo", [
  z.object({ repo: z.literal(false) }),
  z.object({
    repo: z.literal(true),
    branch: z.string().nullable(),
    upstream: z.string().nullable(),
    ahead: z.number().int(),
    behind: z.number().int(),
    files: z.array(changeSchema),
    truncated: z.boolean(),
  }),
]);
export type Status = z.infer<typeof statusSchema>;

const ok = z.object({ output: z.string() });

export const repoStatusSchema = z.object({ repo: z.string(), status: statusSchema });
export type RepoStatus = z.infer<typeof repoStatusSchema>;

const workspaceStatusOutput = z.object({
  name: z.string(),
  repos: z.array(repoStatusSchema),
  truncated: z.boolean(),
});
export type WorkspaceStatus = z.infer<typeof workspaceStatusOutput>;

const message = z.string().trim().min(1).max(20000);
const fileLists = { tracked: z.array(z.string().min(1)), untracked: z.array(z.string().min(1)) };

function contractFor<T extends z.ZodRawShape>(base: T) {
  const repo = { ...base, repo: relPath };
  return defineRpcContract({
    listDir: {
      input: z.object({ ...base, rel: relPath }),
      output: z.object({ entries: z.array(dirEntrySchema), truncated: z.boolean() }),
    },
    workspaceStatus: {
      input: z.object({ ...base, rescan: z.boolean() }),
      output: workspaceStatusOutput,
    },
    search: {
      input: z.object({ ...base, query: z.string().min(1).max(200) }),
      output: z.object({ paths: z.array(z.string()) }),
    },
    diff: {
      input: z.object({ ...repo, path: relPath.min(1), staged: z.boolean(), untracked: z.boolean() }),
      output: z.object({ patch: z.string(), truncated: z.boolean() }),
    },
    stage: { input: z.object({ ...repo, paths: pathList }), output: ok },
    unstage: { input: z.object({ ...repo, paths: pathList }), output: ok },
    discard: { input: z.object({ ...repo, ...fileLists }), output: ok },
    commit: { input: z.object({ ...repo, message, stageAll: z.boolean(), amend: z.boolean() }), output: ok },
    push: { input: z.object(repo), output: ok },
    pull: { input: z.object(repo), output: ok },
  });
}

export const hostContract = contractFor({ root });
export const rpcContract = contractFor({ environmentId: z.string().min(1) });

export const CHANGED_CHANNEL = "changed";
