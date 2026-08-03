import { writeFileSync } from "node:fs";

const destination = process.argv[2];
if (destination === undefined) throw new Error("paste receiver needs an output path");
const outputPath: string = destination;
if (!process.stdin.isTTY || process.stdin.setRawMode === undefined) {
  throw new Error("paste receiver needs a TTY");
}

const START = "\x1b[200~";
const END = "\x1b[201~";
let buffer = "";
let payload: string | null = null;

function finish(): void {
  if (payload === null) return;
  writeFileSync(outputPath, payload, "utf8");
  process.stdout.write("\x1b[?2004l\nPASTE_RECEIVER_SUBMITTED\n");
  process.stdin.setRawMode?.(false);
  process.exit(0);
}

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdout.write("\x1b[?2004hPASTE_RECEIVER_READY\n");

process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  if (buffer.includes("\x03")) {
    process.stdout.write("\x1b[?2004l\nPASTE_RECEIVER_ABORTED\n");
    process.stdin.setRawMode?.(false);
    process.exit(130);
  }
  if (payload === null) {
    const start = buffer.indexOf(START);
    const end = start < 0 ? -1 : buffer.indexOf(END, start + START.length);
    if (start >= 0 && end >= 0) {
      payload = buffer.slice(start + START.length, end);
      buffer = buffer.slice(end + END.length);
      // Echo exactly what landed so TmuxAdapter can perform its normal
      // post-paste verification before sending the one trailing Enter.
      process.stdout.write(payload);
    }
  }
  if (payload !== null && /[\r\n]/u.test(buffer)) finish();
});
