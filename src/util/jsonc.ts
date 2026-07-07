/**
 * Minimal JSONC support: JSON plus // and block comments plus trailing
 * commas. Hand-rolled so the project stays on Bun built-ins only.
 */
export function stripJsonc(input: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < input.length) {
    const c = input[i]!;
    if (inString) {
      out += c;
      if (c === "\\" && i + 1 < input.length) {
        out += input[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && input[i + 1] === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && input[i + 1] === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === ",") {
      // Trailing comma: skip if the next non-whitespace closes a scope.
      let j = i + 1;
      while (j < input.length) {
        const n = input[j]!;
        if (n === "/" && input[j + 1] === "/") {
          while (j < input.length && input[j] !== "\n") j++;
          continue;
        }
        if (n === "/" && input[j + 1] === "*") {
          j += 2;
          while (j < input.length && !(input[j] === "*" && input[j + 1] === "/")) j++;
          j += 2;
          continue;
        }
        if (n === " " || n === "\t" || n === "\n" || n === "\r") {
          j++;
          continue;
        }
        break;
      }
      if (input[j] === "}" || input[j] === "]") {
        i++;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

export function parseJsonc(input: string): unknown {
  return JSON.parse(stripJsonc(input));
}
