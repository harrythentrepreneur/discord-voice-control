// Load <repo>/.env (KEY=value lines) without overriding the real environment.
// Imported first by every entry point, so module-level process.env reads see it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const file = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), ".env");
try {
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
} catch {}
