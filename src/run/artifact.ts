import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { PilotConfig } from "../pilot/config.ts";

const SHA = /^[0-9a-f]{40}$/;

function git(cwd: string, args: string[]): Buffer {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const result = Bun.spawnSync(
    ["git", "--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args],
    {
      cwd,
      env: {
        ...env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_OPTIONAL_LOCKS: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (result.exitCode !== 0) throw new Error("artifact Git validation or export failed");
  return result.stdout;
}

function validateCommit(cfg: PilotConfig, commit: string): string {
  if (!cfg.task) throw new Error("artifact requires a task run");
  const { baseCommit } = cfg.task;
  if (typeof commit !== "string" || !SHA.test(commit) || !SHA.test(baseCommit))
    throw new Error("artifact requires full lowercase commit IDs");
  for (const id of [baseCommit, commit]) {
    if (git(cfg.repo, ["cat-file", "-t", id]).toString().trim() !== "commit")
      throw new Error("artifact object must be a commit");
  }
  git(cfg.repo, ["merge-base", "--is-ancestor", baseCommit, commit]);
  if (git(cfg.repo, ["rev-list", "--min-parents=2", `${baseCommit}..${commit}`, "--"]).length)
    throw new Error("artifact requires linear history without merge commits");
  return baseCommit;
}

export function validateArtifact(cfg: PilotConfig, commit: string): void {
  validateCommit(cfg, commit);
  const implementers = cfg.agents.filter((agent) => agent.id === "claude" && agent.kind === "claude");
  if (implementers.length !== 1) throw new Error("artifact requires one assigned Claude worktree");
  const workspace = implementers[0]!.workspace;
  if (git(workspace, ["rev-parse", "--verify", "HEAD"]).toString().trim() !== commit)
    throw new Error("artifact must equal the assigned Claude worktree HEAD");
  if (
    git(workspace, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none", "-z"])
      .length
  )
    throw new Error("assigned Claude worktree has uncommitted changes");
}

export function validateReviewer(cfg: PilotConfig, runtimeId: string): void {
  if (!cfg.task) throw new Error("review requires a task run");
  const reviewers = cfg.agents.filter((agent) => agent.id === "codex" && agent.kind === "codex");
  if (reviewers.length !== 1 || reviewers[0]!.runtimeId !== runtimeId)
    throw new Error("review requires the assigned Codex runtime");
  const workspace = reviewers[0]!.workspace;
  if (
    workspace !== join(cfg.root, "codex") ||
    realpathSync(workspace) !== workspace ||
    git(workspace, ["rev-parse", "--show-toplevel"]).toString().trim() !== workspace
  )
    throw new Error("review requires the assigned Codex worktree");
  if (
    !SHA.test(cfg.task.baseCommit) ||
    git(workspace, ["rev-parse", "--verify", "HEAD"]).toString().trim() !== cfg.task.baseCommit
  )
    throw new Error("assigned Codex worktree HEAD must remain at the recorded base");
  if (
    git(workspace, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none", "-z"])
      .length
  )
    throw new Error("assigned Codex worktree has uncommitted changes");
}

function existingPatch(path: string, patch: Buffer): boolean {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("result patch must be an owned private file");
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o077)
      throw new Error("result patch must be an owned private file");
    if (!readFileSync(fd).equals(patch))
      throw new Error("result patch already exists with different content");
    return true;
  } finally {
    closeSync(fd);
  }
}

export function exportArtifact(cfg: PilotConfig, commit: string): string {
  const base = validateCommit(cfg, commit);
  const root = lstatSync(cfg.root);
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    root.uid !== process.getuid?.() ||
    root.mode & 0o077 ||
    realpathSync(cfg.root) !== cfg.root
  )
    throw new Error("artifact export requires an owned private run directory");
  const patch = git(cfg.repo, [
    "format-patch",
    "--stdout",
    "--binary",
    "--full-index",
    "--no-ext-diff",
    "--no-textconv",
    "--no-signature",
    `${base}..${commit}`,
    "--",
  ]);
  const path = join(cfg.root, "result.patch");
  if (existingPatch(path, patch)) return path;
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, patch, { flag: "wx", mode: 0o600 });
  try {
    try {
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !existingPatch(path, patch)) throw error;
    }
  } finally {
    unlinkSync(temporary);
  }
  return path;
}
