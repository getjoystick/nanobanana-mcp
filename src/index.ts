#!/usr/bin/env node
/**
 * nanobanana-mcp: a lean MCP server for Google's Nano Banana (Gemini) image models.
 * Tools: generate_image, edit_image, list_models. Saves images to disk and returns
 * file paths (never base64) to keep agent context small.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

// Nano Banana 2 (GA). Override globally via NANOBANANA_MODEL or per-call via `model`.
const DEFAULT_MODEL = process.env.NANOBANANA_MODEL || "gemini-3.1-flash-image";
const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

// Gemini's supported inline input types (GIF is not one of them; PDF is).
const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".pdf": "application/pdf",
};
const EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

let ai: GoogleGenAI | undefined;
function client(): GoogleGenAI {
  if (!API_KEY) {
    throw new Error(
      "GEMINI_API_KEY is not set. Get a key at https://aistudio.google.com/apikey and set it in the MCP server env.",
    );
  }
  return (ai ??= new GoogleGenAI({ apiKey: API_KEY }));
}

// MCP hosts spawn servers without a shell, so a literal ~ can arrive in paths. Expand it here.
function expandTilde(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

// MCP clients (e.g. Claude Desktop) often spawn servers with cwd=/. Never write there.
function defaultDir(): string {
  if (process.env.NANOBANANA_OUTPUT_DIR) return expandTilde(process.env.NANOBANANA_OUTPUT_DIR);
  const cwd = process.cwd();
  const unusable =
    cwd === "/" ||
    cwd === os.homedir() ||
    ["/usr", "/opt", "/var", "/etc", "/System", "/Library", "/private"].some(
      (p) => cwd === p || cwd.startsWith(p + "/"),
    );
  return unusable ? path.join(os.homedir(), "nano-banana") : path.join(cwd, "nano-banana");
}

function slug(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "image";
}

interface Options {
  model?: string;
  aspectRatio?: string;
  size?: "512" | "1K" | "2K" | "4K";
  grounding?: boolean;
  thinkingLevel?: "minimal" | "high";
  outputDir?: string;
  filename?: string;
}

async function run(prompt: string, images: string[], opts: Options): Promise<string> {
  const model = opts.model || DEFAULT_MODEL;

  const parts: Array<Record<string, unknown>> = [{ text: prompt }];
  for (const img of images) {
    const p = path.resolve(expandTilde(img));
    const ext = path.extname(p).toLowerCase();
    const mime = MIME[ext];
    if (!mime) {
      throw new Error(
        `Unsupported input image type "${ext || "(no extension)"}" for ${img}. Use png, jpg, webp, heic, or pdf.`,
      );
    }
    const data = await fs.readFile(p);
    parts.push({ inlineData: { data: data.toString("base64"), mimeType: mime } });
  }

  const config = {
    ...(opts.aspectRatio || opts.size
      ? { imageConfig: { aspectRatio: opts.aspectRatio, imageSize: opts.size } }
      : {}),
    ...(opts.grounding ? { tools: [{ googleSearch: {} }] } : {}),
    ...(opts.thinkingLevel
      ? {
          thinkingConfig: {
            thinkingLevel: opts.thinkingLevel === "high" ? ThinkingLevel.HIGH : ThinkingLevel.MINIMAL,
          },
        }
      : {}),
  };

  let res;
  try {
    res = await client().models.generateContent({
      model,
      contents: [{ role: "user", parts }],
      ...(Object.keys(config).length ? { config } : {}),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/not found|not supported|NOT_FOUND/i.test(msg)) {
      throw new Error(`Model "${model}" is not available: ${msg.slice(0, 200)}. Call list_models to see valid ids.`);
    }
    throw e;
  }

  // Always resolve to an absolute path: the returned "Saved:" path is the contract.
  const dir = path.resolve(opts.outputDir ? expandTilde(opts.outputDir) : defaultDir());
  await fs.mkdir(dir, { recursive: true });

  const saved: string[] = [];
  let note = "";
  for (const part of res.candidates?.[0]?.content?.parts ?? []) {
    if (part.inlineData?.data) {
      const mime = part.inlineData.mimeType ?? "image/png";
      const base =
        saved.length === 0 && opts.filename
          ? path.basename(opts.filename).replace(/\.(png|jpe?g|webp|gif)$/i, "")
          : `${slug(prompt)}-${Date.now().toString(36)}${saved.length ? `-${saved.length}` : ""}`;
      const file = path.join(dir, base + (EXT[mime] ?? ".png"));
      await fs.writeFile(file, Buffer.from(part.inlineData.data, "base64"));
      saved.push(file);
    } else if (part.text) {
      note = part.text;
    }
  }

  if (saved.length === 0) {
    const blocked = res.promptFeedback?.blockReason;
    throw new Error(
      note
        ? `No image returned. Model said: ${note.slice(0, 300)}`
        : `No image returned (model: ${model}${blocked ? `, blocked: ${blocked}` : ""}).`,
    );
  }
  return `Saved: ${saved.join(", ")} (${model})`;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
async function asText(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return { content: [{ type: "text", text: await fn() }] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
  }
}

const common = {
  model: z.string().optional().describe(`Gemini image model id (default: ${DEFAULT_MODEL})`),
  aspectRatio: z.string().optional().describe("e.g. 1:1, 16:9, 9:16, 21:9, up to 1:4 or 8:1"),
  size: z.enum(["512", "1K", "2K", "4K"]).optional().describe("Output resolution"),
  grounding: z.boolean().optional().describe("Ground with Google Search for factual accuracy"),
  thinkingLevel: z
    .enum(["minimal", "high"])
    .optional()
    .describe("Model reasoning effort; high helps complex or text-heavy images"),
  outputDir: z.string().optional().describe("Save directory (default: ./nano-banana)"),
  filename: z.string().optional().describe("Base filename without extension"),
};

const server = new McpServer({ name: "nanobanana-mcp", version });

server.registerTool(
  "generate_image",
  {
    description: "Generate an image from a text prompt. Saves to disk and returns the file path.",
    inputSchema: { prompt: z.string().describe("Image description"), ...common },
  },
  async ({ prompt, ...opts }) => asText(() => run(prompt, [], opts)),
);

server.registerTool(
  "edit_image",
  {
    description:
      "Edit or combine images per a text prompt. First image is the base; any others are references (style, characters, objects). Saves to disk and returns the file path.",
    inputSchema: {
      prompt: z.string().describe("Edit instruction"),
      images: z.array(z.string()).min(1).describe("Input image file path(s)"),
      ...common,
    },
  },
  async ({ prompt, images, ...opts }) => asText(() => run(prompt, images, opts)),
);

server.registerTool(
  "list_models",
  {
    description: "List Gemini image model ids usable with generate_image/edit_image.",
    inputSchema: {},
  },
  async () =>
    asText(async () => {
      const pager = await client().models.list({ config: { pageSize: 200 } });
      const lines: string[] = [];
      for await (const m of pager) {
        const id = (m.name ?? "").replace("models/", "");
        if (id.includes("image") && (m.supportedActions ?? []).includes("generateContent")) {
          lines.push(`${id} (${m.displayName ?? "?"})${id === DEFAULT_MODEL ? " [default]" : ""}`);
        }
      }
      return lines.sort().join("\n") || "No image models available for this API key.";
    }),
);

await server.connect(new StdioServerTransport());
console.error(`nanobanana-mcp ready (default model: ${DEFAULT_MODEL})`);
