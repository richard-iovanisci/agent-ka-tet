/**
 * Dependency-free unified-style line diff, for showing config changes
 * before they are written (CLAUDE.md constraint #4). Config files are
 * small, so the O(n*m) LCS is fine.
 */
export function unifiedDiff(before: string, after: string, label: string): string {
  if (before === after) return "";
  const a = before.split("\n");
  const b = after.split("\n");

  // LCS table
  const m = a.length;
  const n = b.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const lines: string[] = [`--- ${label} (current)`, `+++ ${label} (new)`];
  let i = 0;
  let j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && a[i] === b[j]) {
      lines.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (j < n && (i === m || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      lines.push(`+ ${b[j]}`);
      j++;
    } else if (i < m) {
      lines.push(`- ${a[i]}`);
      i++;
    }
  }
  return lines.join("\n");
}
