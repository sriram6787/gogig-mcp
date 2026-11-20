/**
 * gogig-mcp over stdio: Claude starts this on one person's machine (Claude
 * Code, or Claude desktop's local config). No sign-in flow: the token comes
 * from the environment.
 *
 * Env:
 *   GOGIG_API_URL   the gogig API's base URL (default http://localhost:3000)
 *   GOGIG_TOKEN     that person's gogig JWT (the console's Bearer token)
 *   GOGIG_SAVE_DIR  where report files are saved (default ~/Downloads)
 *
 * Run (as Claude starts it): node dist/stdio.js
 */
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { makeApi, registerGogigTools, SaveFile } from "./tools";

const API_URL = process.env.GOGIG_API_URL || "http://localhost:3000";
const SAVE_DIR = process.env.GOGIG_SAVE_DIR || join(homedir(), "Downloads");

// On one machine, a report file is simply saved next to the person's other downloads.
const saveFile: SaveFile = async (file) => {
  await mkdir(SAVE_DIR, { recursive: true });
  const path = join(SAVE_DIR, basename(file.filename));
  await writeFile(path, file.data);
  return { path };
};

async function main() {
  const server = new McpServer({ name: "gogig-mcp", version: "0.4.0" });
  registerGogigTools(server, makeApi(API_URL, () => process.env.GOGIG_TOKEN), saveFile);
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel; anything for humans goes to stderr.
  console.error(`gogig-mcp ready over stdio (API ${API_URL})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
