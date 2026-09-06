import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { loadPilot, preparePilot } from "../pilot/config.ts";
import { pilotMain } from "../pilot/cli.ts";
import type { Task } from "../coordination/types.ts";
import { exportArtifact } from "./artifact.ts";
import { runConsole } from "./console.ts";

const HELP = `bridge run prepare <project> --task <brief> [--directory <new-directory>]
bridge run launch <directory> --live
bridge run console <directory>
bridge run attach <directory> [claude|codex]
bridge run ready <directory> <claude|codex>
bridge run pause <directory> <claude|codex>
bridge run start <directory>
bridge run status <directory>
bridge run recover <directory>
bridge run export <directory>
bridge run stop <directory>`;

export function parsePrepare(args: string[]): { project: string; brief: string; directory?: string } {
  const project = args[0];
  if (!project || project.startsWith("--")) throw new Error("a source project is required");
  let brief: string | undefined;
  let directory: string | undefined;
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i],
      value = args[i + 1];
    if (!value?.trim()) throw new Error(`${flag} requires a value`);
    if (flag === "--task" && brief === undefined) brief = value;
    else if (flag === "--directory" && directory === undefined) directory = resolve(value);
    else throw new Error(`unknown or repeated option ${flag}`);
  }
  if (!brief?.trim()) throw new Error("--task is required");
  return { project: resolve(project), brief, ...(directory ? { directory } : {}) };
}

export async function runMain(args: string[]): Promise<number> {
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  try {
    const [command, directory, ...extra] = args;
    if (command === "prepare") {
      const input = parsePrepare(args.slice(1));
      const cfg = preparePilot(input.directory, input);
      console.log(
        `Prepared ${cfg.root}\nFollow ${cfg.root}/PLAN.md for native setup.\nThe source checkout is unchanged.`,
      );
      return 0;
    }
    if (!directory) throw new Error("run directory is required");
    const cfg = loadPilot(directory);
    if (!cfg.task) throw new Error("this directory contains a nonce pilot; use bridge pilot");
    if (command === "console") {
      if (extra.length) throw new Error("unexpected console argument");
      return runConsole(cfg.root);
    }
    if (command === "export") {
      if (extra.length) throw new Error("unexpected export argument");
      const db = new Database(cfg.db, { readonly: true });
      let task: Task | null;
      try {
        const row = db
          .query<{ value: string }, [string]>("SELECT value FROM coordination_task WHERE run_id = ?")
          .get(cfg.runId);
        task = row ? (JSON.parse(row.value) as Task) : null;
      } finally {
        db.close();
      }
      if (!task?.artifact || task.state !== "accepted")
        throw new Error("the task needs reviewer acceptance before export");
      console.log(exportArtifact(cfg, task.artifact.commit));
      return 0;
    }
    if (!["launch", "attach", "ready", "pause", "start", "status", "recover", "stop"].includes(command!))
      throw new Error("unknown run command");
    return pilotMain([command!, cfg.root, ...extra]);
  } catch (error) {
    console.error(`bridge run: ${error instanceof Error ? error.message : "operation failed"}`);
    return 1;
  }
}
