# Treehouse

A [bb](https://getbb.app) plugin that adds a **Files** tab to every thread's side panel:

- **Names**: a file tree of the thread's workspace with git badges (`M`, `U`, `A`, `D`), coloured names, dimmed git-ignored entries, and fuzzy **Find files** search. Click a file to open it in bb's preview.
- **Git**: a folder dropdown listing **All repositories** and every folder that directly holds git repositories (for example `.worktrees/feature-x`, `.claude/worktrees/fix-y`, `repositories`). Repositories are found anywhere in the workspace up to 4 levels deep, skipping `node_modules`, build output and `.git`. Each repository is its own collapsible section with its branch, upstream, ahead/behind and `+/-` totals in the header (with pull and push buttons), and inside it a commit message box (Ctrl/⌘+Enter); **Commit** / **Commit All**, **Stage All**; Staged and Changes lists with per-file stage, unstage, discard (click twice to confirm) and open; click a file for its diff. Pull is fast-forward only; the first push sets the upstream.

## Performance

- Folders load only when you expand them (one `readdir` plus one `git check-ignore` for that folder).
- Only the rows on screen are rendered, so huge folders and long change lists scroll smoothly.
- One round trip per refresh returns every repository's status; the host runs `git status --porcelain=v2` for up to 6 repositories in parallel. Repository discovery is cached for 30 seconds (the refresh button rescans).
- Refreshes come from bb's git file watcher, Treehouse's actions, window focus, the refresh button, and a 5-second check while the tab is showing and the window is focused. Unchanged results don't re-render, and nothing runs while the tab is hidden.
- Search uses a 5-second cached `git ls-files` (cached, untracked, not ignored).

## Install

```sh
bb plugin install git:https://github.com/redhajuanda/bb-treehouse --yes
```

Or from a local checkout:

```sh
npm install
bb plugin build .
bb plugin install . --yes
```

Then open the side panel in any thread and pick **Files**.

## CLI

```sh
bb treehouse status <environment-id> [folder] [--json]  # every repository (or those under folder): branch, ahead/behind, changed files
bb treehouse ls <environment-id> [dir] [--json] # one directory, marking ignored entries
```

Find an environment id with `bb status` inside a thread.

## Layout

- `host.ts`: runs on the environment's machine and does all filesystem and `git` work.
- `server.ts`: maps a thread's environment to its host and path, exposes RPC and the CLI, and asks bb's Git plugin to refresh after each change.
- `app.tsx`, `ui/`: the panel tab.
- `contract.ts`: shared RPC schemas.

## Development

```sh
bb plugin dev .
```
