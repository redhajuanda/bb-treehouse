# Working on Treehouse

Treehouse is a bb plugin: a file tree, a multi-repo Git panel and a commit graph in a thread's side panel. These are the rules for changing it. Read the code for everything else.

## Shape

- `server.ts` is the plugin's server entry and the `bb treehouse` CLI. `host.ts` runs on the thread's machine and does every git and filesystem operation. `app.tsx` and `ui/` are the panel. `contract.ts` holds the types and limits they share.
- All git and disk access goes through `host.ts`. The UI never reaches the filesystem or spawns git itself.
- The views are called **Files**, **Diff** and **Graph** everywhere a user can see them (UI, docs, release notes), even where code still uses older names such as `NamesView`.

## Constraints

- Don't poll. Refresh from bb's file watcher, as the existing views do.
- Use bb's theme tokens and code theme. Don't hardcode colours.
- The `bb treehouse` CLI only reads. Writing actions (stage, commit, push, file edits) live in the panel.
- Limits (`MAX_REPOS`, `MAX_STATUS_FILES` and the rest in `contract.ts`, `DISCOVERY_MAX_DEPTH` in `host.ts`) change only when the task is about them, together with the docs that quote them.
- `ui/file-icons.generated.ts` is generated. Change `scripts/generate-file-icons.mjs` and run `node scripts/generate-file-icons.mjs` instead of editing it.
- Every button gets a tooltip. Commands that have a shortcut are registered so they can be rebound in bb's keyboard settings.
- `dist/` is build output and gitignored. Never commit it.

## Before calling a change done

1. `npm run typecheck` passes.
2. `npm test` passes. New logic in `host.ts`, tab state, hunks or the graph gets tests in `tests/` next to the existing ones.
3. For a UI change, see it working in a real bb panel. The installed copy points at this checkout, so `bb plugin reload treehouse` picks up the change.
4. The docs below are updated in the same change.
5. Run `/code-review` on the branch and deal with what it finds before opening the PR.

## Docs that move with the code

A user-visible change updates every one of these that it affects:

- `README.md`: the full feature list.
- `PLUGIN_OVERVIEW.md`: the marketplace overview. Keep it **under 4000 characters** (`wc -c PLUGIN_OVERVIEW.md`).
- `skills/treehouse/SKILL.md`: what agents know about the CLI and the tab. Keep the CLI output format and limits exact.
- `docs/demo.gif`: re-record it when the layout changes noticeably.

Write for users: say what they can do and see, in plain words, not how it is implemented.

## Git

- Never commit to `main` directly. Work on a `feat/<topic>` or `fix/<topic>` branch and open a PR to `main`. PRs are merged with a merge commit.
- Commit subject: short, imperative and user-facing, such as `Edit files in Treehouse tabs`. Body: a bullet list of what changed for the user, and why when that isn't obvious.
- Commit only when the user asks.

## Releasing

Release only when the user asks. Versions follow semver: a fix is a patch, a new feature is a minor.

1. On the release branch, bump `version` in `package.json` and run `npm install` so `package-lock.json` matches.
2. On a minor or major bump, update the install command in `README.md` and in the release notes (`@^0.3.0` becomes `@^0.4.0`).
3. Commit with the subject `vX.Y.Z: <summary>`. Title the PR the same way.
4. After the PR is merged, tag the merge commit on `main` and push the tag:
   ```sh
   git checkout main && git pull
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```
5. Create the GitHub release titled `Treehouse vX.Y.Z`:
   ```sh
   gh release create vX.Y.Z --title "Treehouse vX.Y.Z" --notes-file <notes.md>
   ```
   Notes group the changes under bold headings (for example **New**, **Fixes**), are written for users, mention anything users lose on upgrade (such as reset tabs), and end with the install command:
   ```sh
   bb plugin install git:https://github.com/redhajuanda/bb-treehouse@^X.Y.0 --yes
   ```
