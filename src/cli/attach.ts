import type { BridgeConfig } from "../config.ts";
import type { MuxAdapter } from "../mux/adapter.ts";

export async function attach(cfg: BridgeConfig, opts: { mux: MuxAdapter; print?: (l: string) => void }): Promise<number> {
  const print = opts.print ?? console.log;
  if (!(await opts.mux.hasSession(cfg.session))) {
    print(`session "${cfg.session}" is not running — \`bridge up\` first`);
    return 1;
  }
  const argv = opts.mux.attachArgs(cfg.session);
  const child = Bun.spawn(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return await child.exited;
}
