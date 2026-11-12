import path from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { duplicateName, xdgTrash } from "../host";
import { ctx, host, tempDir, write } from "./helpers";

describe("file actions", () => {
  it("creates files and folders, refusing duplicates and escapes", async () => {
    const root = tempDir();
    mkdirSync(path.join(root, "src"));
    expect(await host.createEntry({ root, parent: "src", name: "a.ts", dir: false }, ctx)).toEqual({ path: "src/a.ts" });
    expect(await host.createEntry({ root, parent: "", name: "docs", dir: true }, ctx)).toEqual({ path: "docs" });
    expect(existsSync(path.join(root, "src/a.ts"))).toBe(true);
    await expect(host.createEntry({ root, parent: "src", name: "a.ts", dir: false }, ctx)).rejects.toThrow(/exists/u);
    await expect(host.createEntry({ root, parent: "..", name: "x", dir: false }, ctx)).rejects.toThrow(/escapes/u);
  });

  it("renames, duplicates and deletes", async () => {
    const root = tempDir();
    write(path.join(root, "notes.md"), "hi\n");
    write(path.join(root, "dir/inner.txt"), "x\n");
    expect(await host.renameEntry({ root, path: "notes.md", name: "readme.md" }, ctx)).toEqual({ path: "readme.md" });
    expect(await host.duplicateEntry({ root, path: "readme.md" }, ctx)).toEqual({ path: "readme copy.md" });
    expect(await host.duplicateEntry({ root, path: "readme.md" }, ctx)).toEqual({ path: "readme copy 2.md" });
    expect(await host.duplicateEntry({ root, path: "dir" }, ctx)).toEqual({ path: "dir copy" });
    expect(readFileSync(path.join(root, "dir copy/inner.txt"), "utf8")).toBe("x\n");
    write(path.join(root, "taken.md"), "");
    await expect(host.renameEntry({ root, path: "readme.md", name: "taken.md" }, ctx)).rejects.toThrow(/exists/u);
    await host.deleteEntry({ root, path: "dir copy", permanent: true }, ctx);
    expect(existsSync(path.join(root, "dir copy"))).toBe(false);
    await expect(host.deleteEntry({ root, path: "", permanent: true }, ctx)).rejects.toThrow();
    await expect(host.deleteEntry({ root, path: ".git/config", permanent: false }, ctx)).rejects.toThrow(/\.git/u);
  });

  it("reads files and archives folders for download", async () => {
    const root = tempDir();
    write(path.join(root, "data.json"), '{"a":1}');
    write(path.join(root, "pkg/index.js"), "export {}\n");
    const file = await host.readEntry({ root, path: "data.json" }, ctx);
    expect(file.fileName).toBe("data.json");
    expect(file.mime).toBe("application/json");
    expect(Buffer.from(file.base64, "base64").toString()).toBe('{"a":1}');
    const archive = await host.readEntry({ root, path: "pkg" }, ctx);
    expect(archive.fileName).toBe("pkg.tar.gz");
    expect(gunzipSync(Buffer.from(archive.base64, "base64")).toString("latin1")).toContain("pkg/index.js");
  });

  it("names copies like a file manager", () => {
    expect(duplicateName("a.test.ts", false, 1)).toBe("a.test copy.ts");
    expect(duplicateName(".env", false, 1)).toBe(".env copy");
    expect(duplicateName("v1.2", true, 3)).toBe("v1.2 copy 3");
  });

  it("moves files into a freedesktop trash with restore info", async () => {
    const root = tempDir();
    const trash = path.join(tempDir(), "Trash");
    write(path.join(root, "notes.md"), "keep me\n");
    write(path.join(root, "other/notes.md"), "second\n");
    const first = await xdgTrash(path.join(root, "notes.md"), trash);
    const second = await xdgTrash(path.join(root, "other/notes.md"), trash);
    expect(existsSync(path.join(root, "notes.md"))).toBe(false);
    expect(readFileSync(first, "utf8")).toBe("keep me\n");
    expect(path.basename(second)).toBe("notes.2.md");
    expect(readdirSync(path.join(trash, "info")).sort()).toEqual(["notes.2.md.trashinfo", "notes.md.trashinfo"]);
    const info = readFileSync(path.join(trash, "info", "notes.md.trashinfo"), "utf8");
    expect(info).toContain(`Path=${path.join(root, "notes.md")}`);
    expect(info).toMatch(/DeletionDate=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u);
  });

  it("moves files and folders between folders", async () => {
    const root = tempDir();
    write(path.join(root, "a/one.txt"), "1\n");
    write(path.join(root, "b/keep.txt"), "k\n");
    write(path.join(root, "b/one.txt"), "taken\n");
    expect(await host.moveEntry({ root, path: "a/one.txt", toDir: "" }, ctx)).toEqual({ path: "one.txt" });
    expect(readFileSync(path.join(root, "one.txt"), "utf8")).toBe("1\n");
    await expect(host.moveEntry({ root, path: "one.txt", toDir: "b" }, ctx)).rejects.toThrow(/already has/u);
    expect(await host.moveEntry({ root, path: "a", toDir: "b" }, ctx)).toEqual({ path: "b/a" });
    await expect(host.moveEntry({ root, path: "b", toDir: "b/a" }, ctx)).rejects.toThrow(/into itself/u);
  });
});
