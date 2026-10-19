// The public MCP manifest, GENERATED from the tool definitions (lazyrelayTools.ts) through the same capture the tools page uses,
// so it lists exactly the tools an agent receives and only the transports the server really serves. Written to
// frontend/public/lazyrelay-mcp.json by backend/scripts/generate-mcp-manifest.ts; mcpManifest.test.ts fails if it is stale.

import { captureTools, MCP_FACTS } from "./mcpDocs.js";

export interface ManifestTool {
  name: string;
  title: string;
  description: string;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  inputSchema: Record<string, unknown>;
}

export type ManifestTransport =
  | { type: "stdio"; package: string; command: string; args: string[]; environmentVariables: string[] }
  | { type: "streamable-http"; url: string; authentication: "oauth2" };

export interface Manifest {
  name: string;
  description: string;
  homepage: string;
  toolsPage: string;
  transports: ManifestTransport[];
  toolCount: number;
  tools: ManifestTool[];
}

export function buildManifest(): Manifest {
  const tools = captureTools().map(
    (t): ManifestTool => ({
      name: t.name,
      title: t.title,
      description: t.description,
      annotations: { readOnlyHint: t.readOnly, destructiveHint: t.destructive, idempotentHint: t.idempotent, openWorldHint: t.openWorld },
      inputSchema: t.inputSchema,
    }),
  );
  return {
    name: "LazyRelay",
    description: "Publish posts to every platform, check platform rules, manage drafts and approvals, read analytics.",
    homepage: MCP_FACTS.setupGuides,
    toolsPage: MCP_FACTS.toolsPage,
    transports: [
      { type: "stdio", package: MCP_FACTS.npmPackage, command: "npx", args: ["-y", MCP_FACTS.npmPackage], environmentVariables: ["LAZYRELAY_API_KEY"] },
      { type: "streamable-http", url: MCP_FACTS.hostedUrl, authentication: "oauth2" },
    ],
    toolCount: tools.length,
    tools,
  };
}

/** The exact text of the file, so the generator and the test cannot disagree about formatting. */
export function renderManifest(manifest: Manifest = buildManifest()): string {
  return JSON.stringify(manifest, null, 2) + "\n";
}
