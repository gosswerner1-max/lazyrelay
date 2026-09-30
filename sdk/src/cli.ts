#!/usr/bin/env node
import { runCli } from "./cliCore.js";

const code = await runCli(process.argv.slice(2), {
  env: process.env,
  out: (text) => {
    process.stdout.write(text);
  },
  err: (text) => {
    process.stderr.write(text);
  },
});
process.exitCode = code;
