---
name: treehouse
description: Read a bb environment's file tree and git changes with the Treehouse plugin's `bb treehouse` CLI. Use when asked what changed in a thread's workspace, to list a workspace directory with ignored entries marked, or about the Treehouse Files tab.
---

# Treehouse

Treehouse adds a **Files** tab (Names | Git) to each thread's side panel.

## CLI

- `bb treehouse status <environment-id> [folder] [--json]` finds every git repository in the workspace (up to 4 levels deep, including hidden folders such as `.worktrees`, skipping `node_modules` and build output) and prints, per repository, `[repo-path] branch -> upstream ↑ahead ↓behind` followed by each changed file as `XY path +add -del` (porcelain v2 index/worktree codes; `??` is untracked). Pass a folder to limit the output to repositories under it. Each repository's list stops at 5000 files with `(truncated)`; nested repositories are not reported as untracked files of their parent.
- `bb treehouse ls <environment-id> [dir] [--json]` lists one directory relative to the workspace root, with directories first and git-ignored entries marked `(ignored)`. Paths that leave the workspace are rejected.

Get the environment id from `bb status` inside a thread.

The CLI only reads. Staging, discarding, committing, pushing and pulling are done in the Git view of the tab.
