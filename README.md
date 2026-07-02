# @nanobanana/mcp 🍌

A lean [MCP](https://modelcontextprotocol.io) server for Google's **Nano Banana** (Gemini) image models. It generates and edits images from any MCP client (Claude Code, Claude Desktop, Cursor) and hands back **file paths instead of base64**, so your agent's context stays small.

- Three tools and nothing else: `generate_image`, `edit_image`, `list_models`
- Defaults to Nano Banana 2 (`gemini-3.1-flash-image`). Switch models per call or via env. If a pinned model id ever goes stale, `list_models` shows what your key can actually use.
- Multi-image editing: pass reference images for style transfer, characters, or compositing
- Control over aspect ratio (`1:1` up to `21:9`) and resolution (`1K`, `2K`, `4K`)
- Google Search grounding for images that need real-world accuracy, like infographics
- Safe output paths. The server never writes to `/` when a desktop MCP client spawns it there.
- Auth lives in env vars only, so your API key never passes through chat context

## Quick start

Get a free Gemini API key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).

**Claude Code**

```bash
claude mcp add nanobanana -e GEMINI_API_KEY=your_key -- npx -y @nanobanana/mcp
```

Also listed in the [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.getjoystick/nanobanana-mcp`.

**Claude Desktop / Cursor**: add this to `claude_desktop_config.json` or `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "nanobanana": {
      "command": "npx",
      "args": ["-y", "@nanobanana/mcp"],
      "env": { "GEMINI_API_KEY": "your_key" }
    }
  }
}
```

## Tools

### `generate_image`

| Param | Required | Description |
|---|---|---|
| `prompt` | ✅ | Image description |
| `model` | | Gemini image model id (default `gemini-3.1-flash-image`) |
| `aspectRatio` | | `1:1`, `16:9`, `9:16`, `4:3`, `21:9`, and similar |
| `size` | | `1K`, `2K`, or `4K` |
| `grounding` | | Ground with Google Search for factual accuracy |
| `outputDir` | | Save directory (default `./nano-banana`) |
| `filename` | | Base filename without extension |

### `edit_image`

Same params, plus:

| Param | Required | Description |
|---|---|---|
| `images` | ✅ | Input image path(s). The first is the base; the rest are references. |

Both tools save to disk and return the file path.

### `list_models`

Takes no params. Lists the image model ids your API key can use. Handy when a
pinned model id stops working, which is how earlier Nano Banana servers broke.

## Configuration

| Env var | Description |
|---|---|
| `GEMINI_API_KEY` | **Required.** Gemini API key (`GOOGLE_API_KEY` also works) |
| `NANOBANANA_MODEL` | Default model override |
| `NANOBANANA_OUTPUT_DIR` | Default output directory override |

## Models

| Model id | Notes |
|---|---|
| `gemini-3.1-flash-image` | **Default.** Nano Banana 2: 4K output, strong text rendering |
| `gemini-3-pro-image` | Nano Banana Pro, for complex scenes that need deeper reasoning |
| `gemini-2.5-flash-image` | The original Nano Banana (legacy; Google retires it 2026-10-02) |

## Development

```bash
npm install
npm run build
GEMINI_API_KEY=your_key npm run smoke   # end-to-end test against the live API
```

## Acknowledgements

Inspired by other Nano Banana MCPs. Built with [Claude Code](https://claude.com/claude-code).

## License

MIT
