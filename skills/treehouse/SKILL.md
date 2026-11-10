---
name: treehouse
description: Read a bb environment's file tree and git changes with the Treehouse plugin's `bb treehouse` CLI. Use when asked what changed in a thread's workspace, to list a workspace directory with ignored entries marked, or about the Treehouse Files tab.
---

# Treehouse

Treehouse adds a **Files** tab (Names | Git) to each thread's side panel.

## CLI

- `bb treehouse status <environment-id> [--json]` prints the branch, upstream, ahead/behind, and each changed file as `XY path +add -del` (porcelain v2 index/worktree codes; `??` is untracked). The list stops at 5000 files and ends with `(truncated)` when it does.
- `bb treehouse ls <environment-id> [dir] [--json]` lists one directory relative to the workspace root, with directories first and git-ignored entries marked `(ignored)`. Paths that leave the workspace are rejected.

Get the environment id from `bb status` inside a thread.

The CLI only reads. Staging, discarding, committing, pushing and pulling are done in the Git view of the tab.
