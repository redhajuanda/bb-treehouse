# Treehouse

A [bb](https://getbb.app) plugin that adds a **Files** tab to every thread's side panel, with three views:

- **Files**: a file tree with a searchable folder picker (the workspace, every folder that holds git repositories such as `.worktrees/feature-x`, and every repository). Picking one roots the tree and **Find files** there. Git badges (`M`, `U`, `A`, `D`) and coloured names come from whichever repository each file belongs to. Ignored entries are judged by the repository that contains them: a folder that is its own repository is never shown as ignored, and inside an ignored folder only the folder itself carries the mark. The eye button hides ignored entries entirely. Click a file to open it in bb's preview.
- **Diff**: a searchable folder picker listing **All repositories** and every folder that directly holds git repositories (for example `.worktrees/feature-x`, `.claude/worktrees/fix-y`, `repositories`). Repositories are found anywhere in the workspace up to 4 levels deep, skipping `node_modules`, build output and `.git`. Each repository is a collapsible section showing its branch, plus pull/push buttons only when it is behind or ahead (or **Publish** when the branch has no upstream). Inside are Staged and Changes lists with per-file stage, unstage, discard (click twice to confirm) and open; click a file to open its diff in its own panel tab (it refreshes as the file changes). Each expanded repository has its own message field (Ctrl/⌘+Enter commits) and a **Commit** button that commits the staged files, or stages and commits everything when nothing is staged; its ▾ menu adds **Commit & Push** and **Amend Last Commit**. Pull is fast-forward only. Each repository also has a **Compare with** section: pick a base branch (defaults to `origin/HEAD`, then `main`/`master`; searchable over local and remote branches) to see how far the current branch is ahead/behind it and every file it changed since they diverged (`base...HEAD`, committed work only), each opening its diff in a tab. It opens automatically when the repository has no uncommitted changes.

- **Graph**: a commit graph for one repository at a time (defaults to the workspace's own repository; the picker lists every repository found). Coloured lanes show branches and merges; each commit shows the author's initials, message, branch/tag badges (the checked-out branch in blue), short hash and relative date. Switch between **All branches** and the current branch, filter loaded commits by message, author, hash or branch, and load 300 more at a time. Click a commit to open it in its own tab with each changed file's diff (merges are shown against their first parent).

## File icons

Files and folders use icons from [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) (MIT), matched by file name (`go.mod`, `Dockerfile`, `package.json`, …), then by extension, including compound ones like `.d.ts` and `.test.ts`. Well-known folders (`src`, `docs`, `.github`, `node_modules`, …) get their own coloured folder icons. To keep the panel fast only a curated set of about 350 icons is bundled; anything else gets the theme's default file or folder icon. To change the set, edit the lists in `scripts/generate-file-icons.mjs` and run:

```sh
npm install
node scripts/generate-file-icons.mjs
```

## Performance

- Folders load only when you expand them (one `readdir` plus one `git check-ignore` for that folder).
- Only the rows on screen are rendered, so huge folders and long change lists scroll smoothly.
- One round trip per refresh returns every repository's status; the host runs `git status --porcelain=v2` for up to 6 repositories in parallel. Repository discovery is cached for 30 seconds (the refresh button rescans).
- Changes are pushed, not polled. While Treehouse is open, bb's native file watcher (on the environment's machine) watches the workspace, skipping `node_modules`, build output and git object stores, plus each repository's git directory (index, HEAD and refs, including linked worktrees' git dirs). Any change sends one debounced signal and the open views refresh. Treehouse's own git reads use `GIT_OPTIONAL_LOCKS=0`, so they never trigger a refresh themselves. The watch is a lease renewed every minute and dropped three minutes after the last Treehouse view closes. If the watcher can't start, Treehouse falls back to a 5-second check while the tab is visible.
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
