import type { MuxAdapter } from "../mux/adapter.ts";
import { agentFile, sourceFile, writePrivateJson, type PilotAgent, type PilotConfig } from "./config.ts";
import { processAlive, processRecord } from "./processState.ts";

export async function launchNativePanes(cfg: PilotConfig, mux: MuxAdapter): Promise<void> {
  const command = (agent: PilotAgent) => [
    process.execPath,
    sourceFile("process.ts"),
    "agent",
    cfg.root,
    agent.id,
    "--wait-for-pane",
  ];
  const first = cfg.agents[0]!;
  const panes = [
    {
      agent: first,
      paneId: await mux.createSession(cfg.tmuxSession, {
        cwd: first.workspace,
        width: 220,
        height: 60,
        command: command(first),
      }),
    },
  ];
  await mux.setSessionMarker(cfg.tmuxSession, `native-pilot:${cfg.id}`);
  for (const agent of cfg.agents.slice(1))
    panes.push({
      agent,
      paneId: await mux.splitPane(cfg.tmuxSession, { cwd: agent.workspace, command: command(agent) }),
    });
  await mux.selectLayout(cfg.tmuxSession, "even-horizontal");
  for (const { agent, paneId } of panes) {
    await mux.setPaneAgentId(paneId, agent.id);
    await mux.setPaneTitle(paneId, agent.id);
  }
  const observed = await mux.listPanes(cfg.tmuxSession);
  const wrappers = new Map<string, number>();
  for (const { agent, paneId } of panes) {
    const pane = observed.find((candidate) => candidate.id === paneId && candidate.agentId === agent.id);
    if (!pane) throw new Error(`${agent.id} pane identity is unavailable; inspect without relaunching`);
    writePrivateJson(agentFile(cfg.root, agent.id, "pane"), { paneId, wrapperPid: pane.pid });
    wrappers.set(agent.id, pane.pid);
  }
  const deadline = Date.now() + 10_000;
  while (true) {
    let ready = true;
    for (const { agent } of panes) {
      const record = processRecord(cfg.root, agent.id);
      if (record && (record.exited || record.pid !== wrappers.get(agent.id)))
        throw new Error(`${agent.id} native startup is unconfirmed; inspect its pane without relaunching`);
      if (!processAlive(record) || !processAlive(record, true)) ready = false;
    }
    if (ready) return;
    if (Date.now() >= deadline)
      throw new Error("native startup is unconfirmed; inspect the panes without relaunching");
    await Bun.sleep(25);
  }
}
