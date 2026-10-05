// The AI agents, editors and automation tools that can run LazyRelay through its hosted MCP server, in the same
// order as the guides on /mcp. One entry per guide page under public/mcp/, so the homepage strip and that page
// cannot drift apart: adding a tool is one array entry here, one icon file in public/ai-tools/, plus its guide page.
//
// Every icon is the tool's own published icon, fetched from the vendor's own site or official account on
// 2026-10-05 and shown unaltered on a plain rounded tile (no recolouring, no added elements, never larger than
// LazyRelay's own branding). Where each came from is recorded in the vault note "reference-ai-tools-strip".
// Names and logos belong to their owners; the strip links to each tool's own setup guide and implies no endorsement
// (the footnote under the strip says so).
export interface AiTool {
  id: string;
  label: string;
  href: string;
  /** File under public/ai-tools/. */
  icon: string;
  /** Tile colour behind icons that are transparent (the black or colour-only marks); icons with their own
   *  background fill the tile. */
  bg?: string;
  /** The icon file itself switches black/white with the visitor's colour scheme (ChatGPT's does), so the tile
   *  colour switches the opposite way in CSS instead of using `bg`. */
  adaptive?: boolean;
}

export const AI_TOOLS: AiTool[] = [
  { id: "claude", label: "Claude", href: "/mcp/claude/", icon: "claude.png" },
  { id: "chatgpt", label: "ChatGPT", href: "/mcp/chatgpt/", icon: "chatgpt.svg", adaptive: true },
  { id: "perplexity", label: "Perplexity", href: "/mcp/perplexity/", icon: "perplexity.svg" },
  { id: "notion", label: "Notion", href: "/mcp/notion/", icon: "notion.png" },
  { id: "manus", label: "Manus", href: "/mcp/manus/", icon: "manus.svg", bg: "#ffffff" },
  { id: "openclaw", label: "OpenClaw", href: "/mcp/openclaw/", icon: "openclaw.svg", bg: "#ffffff" },
  { id: "cursor", label: "Cursor", href: "/mcp/cursor/", icon: "cursor.svg" },
  { id: "windsurf", label: "Windsurf", href: "/mcp/windsurf/", icon: "windsurf.svg" },
  { id: "antigravity", label: "Antigravity", href: "/mcp/antigravity/", icon: "antigravity.png" },
  { id: "codex-cli", label: "Codex CLI", href: "/mcp/codex-cli/", icon: "codex-cli.png" },
  { id: "gemini-cli", label: "Gemini CLI", href: "/mcp/gemini-cli/", icon: "gemini-cli.png" },
  { id: "vscode", label: "VS Code", href: "/mcp/vscode/", icon: "vscode.png" },
  { id: "n8n", label: "n8n", href: "/mcp/n8n/", icon: "n8n.png" },
  { id: "make", label: "Make", href: "/mcp/make/", icon: "make.png" },
  { id: "raycast", label: "Raycast", href: "/mcp/raycast/", icon: "raycast.png" },
];

export function AiToolIcon({ tool, size = 44 }: { tool: AiTool; size?: number }) {
  return (
    <span
      className={tool.adaptive ? "ai-tool-icon ai-tool-icon--adaptive" : "ai-tool-icon"}
      style={{ width: size, height: size, background: tool.bg }}
      aria-hidden="true"
    >
      <img src={`/ai-tools/${tool.icon}`} alt="" width={size} height={size} decoding="async" />
    </span>
  );
}
