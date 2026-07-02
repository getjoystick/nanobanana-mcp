// E2E smoke test: spawns the built server as a real MCP stdio client would.
// Protocol checks always run; live generation runs only if GEMINI_API_KEY is set.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanobanana-smoke-"));
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({
    command: "node",
    args: [new URL("../dist/index.js", import.meta.url).pathname],
    env: { ...process.env, NANOBANANA_OUTPUT_DIR: outDir },
  }),
);

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

// 1. Protocol: tools are listed with expected shapes
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
if (names.join(",") !== "edit_image,generate_image,list_models") fail(`unexpected tools: ${names}`);
const gen = tools.find((t) => t.name === "generate_image");
if (!gen.inputSchema.properties.prompt || !gen.inputSchema.properties.model)
  fail("generate_image schema missing prompt/model");
console.log("PASS: tools/list");

// 1b. Local guards (no API needed): tilde expansion + unsupported input type
const rT = await client.callTool({
  name: "edit_image",
  arguments: { prompt: "x", images: ["~/nonexistent-nanobanana-smoke.png"] },
});
if (!rT.isError || !rT.content[0].text.includes(os.homedir()))
  fail(`tilde not expanded: ${rT.content[0].text}`);
console.log("PASS: ~/ expands to homedir");

const rB = await client.callTool({
  name: "edit_image",
  arguments: { prompt: "x", images: ["/tmp/whatever.bmp"] },
});
if (!rB.isError || !rB.content[0].text.includes("Unsupported input image type"))
  fail(`bmp should be rejected locally: ${rB.content[0].text}`);
console.log("PASS: unsupported input type -> clear local error");

if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
  console.log("SKIP: live API tests (no GEMINI_API_KEY)");
  await client.close();
  process.exit(0);
}

// 2. Live: generate
const r1 = await client.callTool({
  name: "generate_image",
  arguments: { prompt: "a tiny banana wearing sunglasses, flat sticker style", filename: "smoke-gen" },
});
const text1 = r1.content[0].text;
if (r1.isError) fail(`generate_image errored: ${text1}`);
const file1 = text1.match(/Saved: (\S+?\.(?:png|jpg|webp))/)?.[1];
if (!file1 || !fs.existsSync(file1) || fs.statSync(file1).size < 1000)
  fail(`no image file from generate_image: ${text1}`);
console.log(`PASS: generate_image -> ${file1} (${fs.statSync(file1).size} bytes)`);

// 3. Live: edit the generated image
const r2 = await client.callTool({
  name: "edit_image",
  arguments: { prompt: "make the background bright red", images: [file1], filename: "smoke-edit" },
});
const text2 = r2.content[0].text;
if (r2.isError) fail(`edit_image errored: ${text2}`);
const file2 = text2.match(/Saved: (\S+?\.(?:png|jpg|webp))/)?.[1];
if (!file2 || !fs.existsSync(file2) || fs.statSync(file2).size < 1000)
  fail(`no image file from edit_image: ${text2}`);
console.log(`PASS: edit_image -> ${file2} (${fs.statSync(file2).size} bytes)`);

// 4. Error path: bad model id surfaces a clean error pointing at list_models
const r3 = await client.callTool({
  name: "generate_image",
  arguments: { prompt: "x", model: "not-a-real-model" },
});
if (!r3.isError) fail("bad model id should return isError");
if (!r3.content[0].text.includes("list_models")) fail(`bad-model error lacks list_models hint: ${r3.content[0].text}`);
console.log("PASS: bad model id -> clean error with list_models hint");

// 5. Live: list_models returns image models including the default
const r4 = await client.callTool({ name: "list_models", arguments: {} });
const text4 = r4.content[0].text;
if (r4.isError || !text4.includes("gemini-3.1-flash-image") || !text4.includes("[default]"))
  fail(`list_models unexpected: ${text4}`);
console.log(`PASS: list_models -> ${text4.split("\n").length} models`);

await client.close();
console.log(`\nAll smoke tests passed. Output: ${outDir}`);
