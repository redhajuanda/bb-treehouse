import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import entry from "../host";

export const host = entry.handlers;
export const ctx = {} as Parameters<(typeof entry.handlers)["listDir"]>[1];

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "treehouse-test-"));
  created.push(dir);
  return dir;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    encoding: "utf8",
  });
}

export function repo(dir: string, branch = "main"): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", branch);
  return dir;
}

export function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

export function commitAll(dir: string, message: string): void {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", message);
}
