import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pullRequestUrl, webRepoUrl } from "../host";
import { splitHunks } from "../ui/hunks";
import { commitAll, ctx, git, host, repo, tempDir, write } from "./helpers";

describe("workspace status", () => {
  it("reports staged, unstaged, untracked, deleted and renamed files with line counts", async () => {
    const root = repo(tempDir());
    write(path.join(root, "a.txt"), "one\ntwo\n");
    write(path.join(root, "b.txt"), "keep\n");
    write(path.join(root, "old.txt"), "rename me\nplease\n");
    commitAll(root, "init");
    write(path.join(root, "a.txt"), "one\ntwo\nthree\n");
    git(root, "rm", "-q", "b.txt");
    git(root, "mv", "old.txt", "new.txt");
    write(path.join(root, "fresh.ts"), "x\ny\n");

    const result = await host.workspaceStatus({ root, rescan: true }, ctx);
    const status = result.repos[0]?.status;
    if (status === undefined || !status.repo) throw new Error("expected a repository");
    const byPath = Object.fromEntries(status.files.map((f) => [f.path, f]));

    expect(status.branch).toBe("main");
    expect(byPath["a.txt"]).toMatchObject({ x: " ", y: "M", add: 1, del: 0 });
    expect(byPath["b.txt"]).toMatchObject({ x: "D" });
    expect(byPath["new.txt"]).toMatchObject({ x: "R", orig: "old.txt" });
    expect(byPath["fresh.ts"]).toMatchObject({ x: "?", add: 2 });
  });

  it("finds nested repositories and keeps them out of the parent's untracked list", async () => {
    const root = repo(tempDir());
    commitAll(root, "init");
    const nested = repo(path.join(root, ".worktrees", "feat", "api"));
    write(path.join(nested, "main.go"), "package main\n");

    const result = await host.workspaceStatus({ root, rescan: true }, ctx);
    expect(result.repos.map((r) => r.repo)).toEqual(["", ".worktrees/feat/api"]);
    const parent = result.repos[0]?.status;
    if (parent === undefined || !parent.repo) throw new Error("expected a repository");
    expect(parent.files).toEqual([]);
    const child = result.repos[1]?.status;
    if (child === undefined || !child.repo) throw new Error("expected a repository");
    expect(child.files.map((f) => f.path)).toEqual(["main.go"]);
  });
});

describe("file tree ignore rules", () => {
  it("judges ignores by the repository that owns each folder", async () => {
    const root = repo(tempDir());
    write(path.join(root, ".gitignore"), ".worktrees/\nnode_modules/\n");
    write(path.join(root, "node_modules", "x", "index.js"), "");
    const nested = repo(path.join(root, ".worktrees", "feat", "api"));
    write(path.join(nested, ".gitignore"), "bin/\n");
    write(path.join(nested, "bin", "app"), "");
    write(path.join(nested, "main.go"), "");

    const names = async (rel: string) =>
      (await host.listDir({ root, rel }, ctx)).entries.map((e) => `${e.name}${e.ignored ? "!" : ""}`);

    expect(await names("")).toEqual([".worktrees!", "node_modules!", ".gitignore"]);
    expect(await names(".worktrees")).toEqual(["feat"]);
    expect(await names(".worktrees/feat")).toEqual(["api"]);
    expect(await names(".worktrees/feat/api")).toEqual(["bin!", ".gitignore", "main.go"]);
  });

  it("refuses paths outside the workspace", async () => {
    const root = repo(tempDir());
    await expect(host.listDir({ root, rel: "../.." }, ctx)).rejects.toThrow(/escapes the workspace/u);
  });
});

describe("search", () => {
  it("searches inside nested repositories under the chosen folder", async () => {
    const root = repo(tempDir());
    commitAll(root, "init");
    const nested = repo(path.join(root, "repositories", "web"));
    write(path.join(nested, "src", "button.tsx"), "");
    write(path.join(root, "button-notes.md"), "");

    const scoped = await host.search({ root, base: "repositories", query: "button" }, ctx);
    expect(scoped.paths).toEqual(["repositories/web/src/button.tsx"]);
    const everywhere = await host.search({ root, base: "", query: "button" }, ctx);
    expect(everywhere.paths).toContain("button-notes.md");
    expect(everywhere.paths).toContain("repositories/web/src/button.tsx");
  });
});

describe("hunks", () => {
  it("stages, unstages and discards single hunks", async () => {
    const root = repo(tempDir());
    write(path.join(root, "f.txt"), `${Array.from({ length: 40 }, (_, i) => i + 1).join("\n")}\n`);
    commitAll(root, "init");
    const edited = readFileSync(path.join(root, "f.txt"), "utf8").replace(/^3$/mu, "three").replace(/^35$/mu, "35!");
    write(path.join(root, "f.txt"), edited);

    const worktree = await host.diff({ root, repo: "", path: "f.txt", staged: false, untracked: false }, ctx);
    const hunks = splitHunks(worktree.patch);
    expect(hunks).toHaveLength(2);

    await host.applyHunk({ root, repo: "", patch: hunks[1]?.patch ?? "", mode: "stage" }, ctx);
    expect(git(root, "diff", "--cached")).toContain("+35!");
    expect(git(root, "diff", "--cached")).not.toContain("+three");

    const staged = await host.diff({ root, repo: "", path: "f.txt", staged: true, untracked: false }, ctx);
    await host.applyHunk({ root, repo: "", patch: splitHunks(staged.patch)[0]?.patch ?? "", mode: "unstage" }, ctx);
    expect(git(root, "diff", "--cached")).toBe("");

    const again = await host.diff({ root, repo: "", path: "f.txt", staged: false, untracked: false }, ctx);
    await host.applyHunk({ root, repo: "", patch: splitHunks(again.patch)[0]?.patch ?? "", mode: "discard" }, ctx);
    const left = git(root, "diff");
    expect(left).toContain("+35!");
    expect(left).not.toContain("three");
  });
});

describe("compare", () => {
  it("lists what a branch changed since it left the base", async () => {
    const root = repo(tempDir());
    write(path.join(root, "a.txt"), "a\n");
    commitAll(root, "init");
    git(root, "checkout", "-q", "-b", "feature");
    write(path.join(root, "a.txt"), "a\nmore\n");
    write(path.join(root, "b.txt"), "b\n");
    commitAll(root, "feature work");
    git(root, "checkout", "-q", "main");
    write(path.join(root, "main-only.txt"), "m\n");
    commitAll(root, "main moves on");
    git(root, "checkout", "-q", "feature");

    const result = await host.compare({ root, repo: "", base: "main" }, ctx);
    expect(result).toMatchObject({ found: true, ahead: 1, behind: 1 });
    expect(result.files.map((f) => `${f.status} ${f.path} +${f.add}`)).toEqual(["M a.txt +1", "A b.txt +1"]);

    const branches = await host.branches({ root, repo: "" }, ctx);
    expect(branches.current).toBe("feature");
    expect(branches.defaultBase).toBe("main");

    const missing = await host.compare({ root, repo: "", base: "nope" }, ctx);
    expect(missing.found).toBe(false);
  });
});

describe("commits", () => {
  it("commits staged files only, and everything when asked", async () => {
    const root = repo(tempDir());
    write(path.join(root, "a.txt"), "a\n");
    commitAll(root, "init");
    write(path.join(root, "a.txt"), "a2\n");
    write(path.join(root, "b.txt"), "b\n");
    git(root, "add", "a.txt");

    await host.commit({ root, repo: "", message: "change a", stageAll: false, amend: false }, ctx);
    expect(git(root, "show", "--name-only", "--format=", "HEAD").trim()).toBe("a.txt");
    expect(existsSync(path.join(root, "b.txt"))).toBe(true);

    await host.commit({ root, repo: "", message: "everything", stageAll: true, amend: false }, ctx);
    expect(git(root, "status", "--porcelain")).toBe("");
    await host.commit({ root, repo: "", message: "everything, reworded", stageAll: false, amend: true }, ctx);
    expect(git(root, "log", "-n", "1", "--format=%s").trim()).toBe("everything, reworded");
  });
});

describe("history", () => {
  it("reports full ref names so local slash branches are not mistaken for remotes", async () => {
    const root = repo(tempDir());
    write(path.join(root, "a.txt"), "a\n");
    commitAll(root, "init");
    git(root, "branch", "feature/checkout");
    git(root, "tag", "v1.0.0");
    const page = await host.log({ root, repo: "", all: true, skip: 0, limit: 10 }, ctx);
    expect(page.commits[0]?.refs.split(", ").sort()).toEqual([
      "HEAD -> refs/heads/main",
      "refs/heads/feature/checkout",
      "tag: refs/tags/v1.0.0",
    ]);
  });
});

describe("pull request links", () => {
  it.each([
    ["git@github.com:acme/app.git", "https://github.com/acme/app/compare/main...feat/x?expand=1"],
    ["https://github.com/acme/app", "https://github.com/acme/app/compare/main...feat/x?expand=1"],
    [
      "ssh://git@gitlab.example.com:2222/group/sub/app.git",
      "https://gitlab.example.com/group/sub/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat%2Fx&merge_request%5Btarget_branch%5D=main",
    ],
    ["git@bitbucket.org:team/app.git", "https://bitbucket.org/team/app/pull-requests/new?source=feat%2Fx&dest=main"],
  ])("%s", (remote, expected) => {
    const web = webRepoUrl(remote);
    if (web === null) throw new Error("expected a web URL");
    expect(pullRequestUrl(web, "feat/x", "main")).toBe(expected);
  });

  it("rejects remotes that are not URLs", () => {
    expect(webRepoUrl("/srv/git/app.git")).toBeNull();
  });
});
