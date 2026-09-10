#!/usr/bin/env node
// PostToolUse hook (Edit|Write) for LazyRelay: after a .ts/.tsx file is
// edited, auto-format it with prettier and surface any tsc --noEmit errors
// for that file back to Claude as additionalContext. Cross-platform (no
// bash-only syntax) since this repo is developed on Windows.
//
// Never blocks the edit: a hook bug, a missing prettier install, or a real
// tsc error all just get swallowed or reported -- none of them should stop
// the tool result from returning.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    main(JSON.parse(input));
  } catch {
    // Malformed input or an unexpected error -- fail silently, never block.
  }
  process.exit(0);
});

function main(payload) {
  const filePath = payload?.tool_input?.file_path || payload?.tool_response?.filePath;
  if (!filePath || !/\.(ts|tsx)$/.test(filePath) || !fs.existsSync(filePath)) return;

  const projectDir = findUp(path.dirname(filePath), "package.json");
  if (projectDir) formatWithPrettier(projectDir, filePath);

  const tsconfigDir = findUp(path.dirname(filePath), "tsconfig.json");
  if (!tsconfigDir) return;

  const errors = typecheckErrorsFor(tsconfigDir, filePath);
  if (errors.length === 0) return;

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: `tsc --noEmit found issues in ${filePath}:\n${errors.join("\n")}`,
      },
    }),
  );
}

function formatWithPrettier(projectDir, filePath) {
  if (!fs.existsSync(path.join(projectDir, "node_modules", ".bin", "prettier")) &&
      !fs.existsSync(path.join(projectDir, "node_modules", "prettier"))) {
    return; // prettier isn't installed for this subproject -- nothing to run
  }
  try {
    execFileSync("npx", ["--prefix", projectDir, "prettier", "--write", filePath], {
      stdio: ["ignore", "ignore", "ignore"],
      shell: true,
    });
  } catch {
    // Prettier failed on this file (e.g. a syntax error mid-edit) -- leave
    // the file as Claude wrote it, don't block on a formatter hiccup.
  }
}

function typecheckErrorsFor(tsconfigDir, filePath) {
  let output = "";
  try {
    execFileSync("npx", ["tsc", "--noEmit", "--pretty", "false"], {
      cwd: tsconfigDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });
  } catch (e) {
    output = (e.stdout || "") + (e.stderr || "");
  }
  const base = path.basename(filePath);
  return output
    .split(/\r?\n/)
    .filter((line) => line.includes(base))
    .slice(0, 15);
}

function findUp(startDir, filename) {
  let dir = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(dir, filename))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
