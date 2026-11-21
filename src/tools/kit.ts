/**
 * What every tool group is handed: the API client, the file saver, and `tool()`
 * to register one tool. Also the input pieces several tools share.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GogigApi, SaveFile } from "./api";

export type ToolFn = (
  name: string,
  description: string,
  shape: z.ZodRawShape,
  run: (args: any) => Promise<unknown>,
  /** false marks tools that start work or send email, so Claude asks first. */
  readOnly?: boolean,
) => void;

export interface Kit {
  api: GogigApi;
  saveFile: SaveFile;
  tool: ToolFn;
}

export function makeKit(server: McpServer, api: GogigApi, saveFile: SaveFile): Kit {
  // Plain signature: the SDK's generic one recurses too deep under the root tsconfig (TS2589).
  const register = server.registerTool.bind(server) as (
    name: string,
    config: {
      description: string;
      inputSchema: z.ZodRawShape;
      annotations: { readOnlyHint: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
    },
    cb: (args: any) => Promise<unknown>,
  ) => unknown;

  const tool: ToolFn = (name, description, shape, run, readOnly = true) => {
    register(
      name,
      {
        description,
        inputSchema: shape,
        annotations: readOnly
          ? { readOnlyHint: true }
          : { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      async (args: any) => {
        try {
          const data = await run(args);
          // Compact JSON: Claude reads every byte of a result, and pays for it in tokens.
          return { content: [{ type: "text" as const, text: JSON.stringify(redact(data)) }] };
        } catch (e) {
          return { content: [{ type: "text" as const, text: (e as Error).message }], isError: true };
        }
      },
    );
  };

  return { api, saveFile, tool };
}

// ------------------------------------------------------------------ privacy ---

// Phone numbers and contact details never reach Claude, whatever the route returns.
const PRIVATE_KEY = /phone|mobile|contact|whatsapp/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (!PRIVATE_KEY.test(key)) out[key] = redact(inner);
    }
    return out;
  }
  return value;
}

// ------------------------------------------------------------ shared inputs ---

export const page = z.number().int().min(1).optional().describe("Page number, from 1. Default 1.");

export const csv = (what: string) =>
  z.array(z.string().min(1).max(100)).max(20).optional().describe(`${what} Optional.`);

/** A list as the API's comma-separated query value; nothing when empty. */
export const joined = (values?: string[]) => (values?.length ? values.join(",") : undefined);

/** Keeps only `keys` of `row`, so big or private rows shrink to what an answer needs. */
export const pick = (row: any, keys: string[]) =>
  Object.fromEntries(keys.filter((key) => row?.[key] !== undefined).map((key) => [key, row[key]]));

export const day = (what: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
    .optional()
    .describe(`${what} day, YYYY-MM-DD, inclusive. Optional.`);

export const campaignId = z.string().min(1).describe("The campaign's gigId, from find_campaign.");

export const reasonCodes = z
  .array(z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/))
  .max(50)
  .optional()
  .describe("Only tasks flagged with these reason codes, e.g. [\"entryOutOfGeoFence\"]. Optional.");

export const pageSize = (max: number, fallback: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(max)
    .optional()
    .describe(`How many rows, 1-${max}. Default ${fallback}.`);

// "from,to" the way the report routes take dates; one date alone means that single day.
export const dateFilter = (from?: string, to?: string) =>
  from || to ? `${from || to},${to || from}` : undefined;
