import { chmodSync, existsSync } from "node:fs";

// The CLI entry needs the executable bit on Unix. On Windows this is a harmless no-op.
const cli = new URL("../dist/cli.js", import.meta.url);
if (existsSync(cli)) chmodSync(cli, 0o755);
