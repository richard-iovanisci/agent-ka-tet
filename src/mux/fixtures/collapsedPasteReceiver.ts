import { writeFileSync } from "node:fs";

type Kind = "claude" | "codex";
type Behavior =
  | "normal"
  | "literal"
  | "both"
  | "silent"
  | "duplicate"
  | "replace-duplicate"
  | "delayed";

const kind = process.argv[2] as Kind | undefined;
const behavior = process.argv[3] as Behavior | undefined;
const outputArg = process.argv[4];
const auditArg = process.argv[5];
if (
  (kind !== "claude" && kind !== "codex") ||
  ![
    "normal",
    "literal",
    "both",
    "silent",
    "duplicate",
    "replace-duplicate",
    "delayed",
  ].includes(behavior ?? "") ||
  outputArg === undefined ||
  auditArg === undefined
) {
  throw new Error(
    "usage: collapsedPasteReceiver <claude|codex> <normal|literal|both|silent|duplicate|replace-duplicate|delayed> <output> <audit>",
  );
}
const outputPath: string = outputArg;
const auditPath: string = auditArg;
if (!process.stdin.isTTY || process.stdin.setRawMode === undefined) {
  throw new Error("collapsed paste receiver needs a TTY");
}

const START = "\x1b[200~";
const END = "\x1b[201~";
const payloads: string[] = [];
let buffer = "";
let submitted = 0;

function audit(): void {
  writeFileSync(auditPath, JSON.stringify({ payloads, submitted }), "utf8");
}

function placeholder(payload: string): string {
  if (kind === "codex") {
    const characters = Array.from(payload).length;
    const suffix = payloads.length > 1 ? ` #${payloads.length}` : "";
    return `[Pasted Content ${characters} chars]${suffix}`;
  }
  const extraLines = Math.max(1, payload.split("\n").length - 1);
  return `[Pasted text #${payloads.length} +${extraLines} lines]`;
}

function renderReceipt(payload: string): void {
  if (behavior === "silent") return;
  const receipt = behavior === "literal"
    ? payload
    : behavior === "both"
    ? `${payload}${placeholder(payload)}`
    : placeholder(payload);
  const render = (): void => {
    if (behavior === "replace-duplicate") process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(receipt);
    if (behavior === "duplicate" || behavior === "replace-duplicate") {
      process.stdout.write(receipt);
    }
  };
  if (behavior === "delayed") setTimeout(render, 140);
  else render();
}

function finish(): void {
  if (payloads.length === 0) return;
  submitted++;
  audit();
  writeFileSync(outputPath, payloads[0] ?? "", "utf8");
  process.stdout.write("\x1b[?2004l\nCOLLAPSED_RECEIVER_SUBMITTED\n");
  process.stdin.setRawMode?.(false);
  process.exit(0);
}

function consumePastes(): void {
  for (;;) {
    const start = buffer.indexOf(START);
    if (start < 0) return;
    const end = buffer.indexOf(END, start + START.length);
    if (end < 0) return;
    const payload = buffer.slice(start + START.length, end);
    buffer = buffer.slice(end + END.length);
    payloads.push(payload);
    audit();
    renderReceipt(payload);
  }
}

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdout.write(`\x1b[?2004hCOLLAPSED_RECEIVER_READY ${kind} ${behavior}\n`);
if (behavior === "replace-duplicate") {
  process.stdout.write("[Pasted text #0 +1 lines]");
}

process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  if (buffer.includes("\x03")) {
    process.stdout.write("\x1b[?2004l\nCOLLAPSED_RECEIVER_ABORTED\n");
    process.stdin.setRawMode?.(false);
    process.exit(130);
  }
  consumePastes();
  if (payloads.length > 0 && /[\r\n]/u.test(buffer)) finish();
});
