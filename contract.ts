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
  root: z.string(),
  repos: z.array(repoStatusSchema),
  truncated: z.boolean(),
});
export type WorkspaceStatus = z.infer<typeof workspaceStatusOutput>;

export const MAX_LOG_PAGE = 500;
const shaSchema = z.string().regex(/^[0-9a-f]{4,40}$/iu);

export const commitSchema = z.object({
  sha: z.string(),
  parents: z.array(z.string()),
  author: z.string(),
  email: z.string(),
  time: z.number(),
  refs: z.string(),
  subject: z.string(),
});
export type Commit = z.infer<typeof commitSchema>;

const logOutput = z.object({ commits: z.array(commitSchema), hasMore: z.boolean() });
export type LogPage = z.infer<typeof logOutput>;

export const commitFileSchema = z.object({
  path: z.string(),
  patch: z.string(),
  add: z.number().int().nullable(),
  del: z.number().int().nullable(),
  truncated: z.boolean(),
});
export type CommitFile = z.infer<typeof commitFileSchema>;

const showOutput = z.object({
  sha: z.string(),
  parents: z.array(z.string()),
  author: z.string(),
  email: z.string(),
  time: z.number(),
  subject: z.string(),
  body: z.string(),
  files: z.array(commitFileSchema),
  truncated: z.boolean(),
});
export type CommitDetail = z.infer<typeof showOutput>;

const refName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^\s~^:?*\[\\]+$/u)
  .refine((value) => !value.startsWith("-") && !value.includes(".."), "Invalid branch name");

export const branchSchema = z.object({ name: z.string(), remote: z.boolean() });
const branchesOutput = z.object({
  current: z.string().nullable(),
  defaultBase: z.string().nullable(),
  branches: z.array(branchSchema),
});
export type BranchList = z.infer<typeof branchesOutput>;

export const compareFileSchema = z.object({
  path: z.string(),
  orig: z.string().nullable(),
  status: z.enum(["A", "M", "D", "R", "C", "T"]),
  add: z.number().int().nullable(),
  del: z.number().int().nullable(),
});
export type CompareFile = z.infer<typeof compareFileSchema>;
const compareOutput = z.object({
  base: z.string(),
  found: z.boolean(),
  ahead: z.number().int(),
  behind: z.number().int(),
  files: z.array(compareFileSchema),
  truncated: z.boolean(),
});
export type CompareResult = z.infer<typeof compareOutput>;

export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
export const entryName = z
  .string()
  .trim()
  .min(1, "Enter a name")
  .max(255)
  .refine((value) => value !== "." && value !== ".." && !/[\\/\0]/u.test(value), "Names cannot contain / or \\")
  .refine((value) => value !== ".git", "That name is reserved by git");
const entryPath = relPath.min(1);

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
      input: z.object({ ...base, base: relPath, query: z.string().min(1).max(200) }),
      output: z.object({ paths: z.array(z.string()) }),
    },
    diff: {
      input: z.object({ ...repo, path: relPath.min(1), staged: z.boolean(), untracked: z.boolean() }),
      output: z.object({ patch: z.string(), truncated: z.boolean() }),
    },
    watch: {
      input: z.object(base),
      output: z.object({ watching: z.boolean() }),
    },
    log: {
      input: z.object({
        ...repo,
        all: z.boolean(),
        skip: z.number().int().min(0).max(1_000_000),
        limit: z.number().int().min(1).max(MAX_LOG_PAGE),
      }),
      output: logOutput,
    },
    show: { input: z.object({ ...repo, sha: shaSchema }), output: showOutput },
    branches: { input: z.object(repo), output: branchesOutput },
    applyHunk: {
      input: z.object({
        ...repo,
        patch: z
          .string()
          .min(1)
          .max(2 * 1024 * 1024),
        mode: z.enum(["stage", "unstage", "discard"]),
      }),
      output: ok,
    },
    createPr: {
      input: z.object({ ...repo, base: refName }),
      output: z.object({ url: z.string().nullable(), pushed: z.boolean(), remote: z.string().nullable() }),
    },
    commitContext: {
      input: z.object(repo),
      output: z.object({
        stagedOnly: z.boolean(),
        stat: z.string(),
        patch: z.string(),
        truncated: z.boolean(),
        recent: z.array(z.string()),
        branch: z.string().nullable(),
      }),
    },
    compare: { input: z.object({ ...repo, base: refName }), output: compareOutput },
    compareDiff: {
      input: z.object({ ...repo, base: refName, path: relPath.min(1) }),
      output: z.object({ patch: z.string(), truncated: z.boolean() }),
    },
    stage: { input: z.object({ ...repo, paths: pathList }), output: ok },
    unstage: { input: z.object({ ...repo, paths: pathList }), output: ok },
    discard: { input: z.object({ ...repo, ...fileLists }), output: ok },
    commit: { input: z.object({ ...repo, message, stageAll: z.boolean(), amend: z.boolean() }), output: ok },
    push: { input: z.object(repo), output: ok },
    pull: { input: z.object(repo), output: ok },
    createEntry: {
      input: z.object({ ...base, parent: relPath, name: entryName, dir: z.boolean() }),
      output: z.object({ path: z.string() }),
    },
    renameEntry: {
      input: z.object({ ...base, path: entryPath, name: entryName }),
      output: z.object({ path: z.string() }),
    },
    duplicateEntry: { input: z.object({ ...base, path: entryPath }), output: z.object({ path: z.string() }) },
    deleteEntry: { input: z.object({ ...base, path: entryPath }), output: z.object({ path: z.string() }) },
    readEntry: {
      input: z.object({ ...base, path: entryPath }),
      output: z.object({ fileName: z.string(), base64: z.string(), mime: z.string() }),
    },
    revealEntry: { input: z.object({ ...base, path: relPath }), output: z.object({ opened: z.boolean() }) },
  });
}

export const hostContract = {
  ...contractFor({ root }),
  ...defineRpcContract({
    claudeCli: {
      input: z.object({ root, prompt: z.string().min(1).max(400_000) }),
      output: z.object({ available: z.boolean(), text: z.string() }),
    },
  }),
};
export const rpcContract = {
  ...contractFor({ environmentId: z.string().min(1) }),
  ...defineRpcContract({
    locate: {
      input: z.object({ environmentId: z.string().min(1) }),
      output: z.object({ hostId: z.string(), root: z.string() }),
    },
    suggestMessage: {
      input: z.object({ environmentId: z.string().min(1), repo: relPath }),
      output: z.object({ message: z.string(), source: z.enum(["api", "cli"]) }),
    },
  }),
};

export const CHANGED_CHANNEL = "changed";

export const hostSignals = {
  changed: { payload: z.object({ root: z.string() }) },
} as const;

export const WATCH_LEASE_MS = 3 * 60_000;
export const WATCH_RENEW_MS = 60_000;
