# HDL Wave AI

AI-assisted hardware verification for VS Code. Connect your active simulation waveform to an LLM — ask questions about signal behavior, debug logic errors, and cross-reference transitions against your HDL source in natural language.

Built as a companion to the [VaporView](https://marketplace.visualstudio.com/items?itemName=lramseyer.vaporview) waveform viewer.

---

## How it works

1. Open a VCD/FST file in VaporView and add signals to the viewer
2. Optionally place VaporView's markers to define a time window of interest
3. Open the HDL Wave AI chat (`HDL Wave AI: Open Chat` from the Command Palette)
4. Ask questions — the extension automatically injects:
   - Signal transition data for the marked (or full) time range
   - Relevant HDL module source ranked by match to your tracked signals
5. Continue the conversation — subsequent messages use the same context without re-fetching

---

## Requirements

- [VaporView](https://marketplace.visualstudio.com/items?itemName=lramseyer.vaporview) — VS Code will prompt you to install it automatically
- An LLM provider: either an [Anthropic API key](https://console.anthropic.com/) or a locally running [Ollama](https://ollama.com/) instance

---

## Quick Start

### Using Claude (Anthropic)

1. Install the extension
2. Open VS Code Settings (`Ctrl+,`) and search `hdlWaveAi`
3. Set **Provider** to `anthropic`
4. Paste your Anthropic API key into **Anthropic: Api Key**
5. Open a VCD in VaporView, add signals, then run `HDL Wave AI: Open Chat`

### Using a local model via Ollama

```bash
# Install Ollama and pull a model (recommended: deepseek-coder-v2:32b)
ollama pull deepseek-coder-v2:32b
```

**Recommended model:** `deepseek-coder-v2:32b` — best balance of code reasoning, tool-use reliability, and Verilog/SystemVerilog comprehension for local inference. Smaller models (16b and below) work but produce shallower analysis and less reliable tool calling.

Set in VS Code Settings:
- **Provider** → `openai-compatible`
- **Openai Compatible: Base Url** → `http://localhost:11434/v1`
- **Openai Compatible: Model** → `deepseek-coder-v2:32b`

Or run Ollama via Docker — see the [Dockerfile](https://github.com/andrewcapatina/hdl-wave-ai) in the repo for GPU-accelerated setup.

---

## Usage

### Workflow

1. Simulate your design and open the resulting VCD/FST file in VaporView
2. Add the signals you care about to the VaporView signal list
3. *(Optional)* Place VaporView's primary and alt markers to focus on a specific time window
4. Run `HDL Wave AI: Open Chat` from the Command Palette (`Ctrl+Shift+P`)
5. Ask questions — the first message automatically collects and injects waveform + HDL context

### Tips

- **Markers**: If no markers are set the extension samples the entire simulation. Setting both VaporView markers to bracket the region of interest gives the LLM a tighter, more relevant window.
- **HDL source**: Open your RTL directory as the VS Code workspace, or configure `hdlWaveAi.hdl.searchPaths` to point at it. The extension finds modules whose signal names match what's in the viewer.
- **Stop**: A **Stop** button appears during streaming — click it to cancel a response mid-generation without losing conversation history.

### Generating a VCD for testing

If you don't have a VCD handy, Icarus Verilog can generate one from any Verilog testbench:

```bash
sudo apt install iverilog
iverilog -o sim testbench.v design.v && ./sim
# produces output.vcd
```

Add `$dumpfile("output.vcd"); $dumpvars(0, tb);` to your testbench's `initial` block.

---

## Tool-Use (RAG) Mode

For large designs with millions of signal transitions, the extension uses a tool-calling approach instead of dumping all transitions into the LLM context. The LLM receives a compact waveform summary and queries signal data on-demand through tools.

This is enabled by default (`hdlWaveAi.waveform.useToolMode: true`) and works with both Anthropic and OpenAI-compatible providers. If the provider doesn't support tool calling, it falls back to legacy mode automatically.

---

## MCP Server

The extension includes a standalone MCP (Model Context Protocol) server that exposes waveform query tools to any MCP-compatible client — Claude Code, Claude Desktop, Cursor, and others. This runs independently of VS Code.

### Setup

Build the server (if not already built):

```bash
cd hdl-wave-ai
npm install
npm run compile
```

This produces `dist/mcp-server.js`.

### Claude Code

```bash
claude mcp add hdl-wave-ai node /path/to/hdl-wave-ai/dist/mcp-server.js
```

Or to pre-load a waveform on startup:

```bash
claude mcp add hdl-wave-ai node -- /path/to/hdl-wave-ai/dist/mcp-server.js /path/to/waveform.vcd
```

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "hdl-wave-ai": {
      "command": "node",
      "args": ["/path/to/hdl-wave-ai/dist/mcp-server.js"]
    }
  }
}
```

### Project-level config (`.mcp.json`)

```json
{
  "mcpServers": {
    "hdl-wave-ai": {
      "command": "node",
      "args": ["/path/to/hdl-wave-ai/dist/mcp-server.js", "/path/to/waveform.vcd"]
    }
  }
}
```

### Available Tools

| Tool | Description |
|---|---|
| `load_waveform` | Load a VCD or FST file (replaces any previously loaded waveform) |
| `list_signals` | List all signals with transition counts |
| `query_transitions` | Get transitions for a signal in a time range (capped at 150) |
| `get_value_at` | Get the value of a signal at a specific timestamp |
| `find_hdl_modules` | Search directories for HDL modules ranked by relevance to loaded waveform signals |

### Example Prompt

After loading a waveform, try:

> Load the waveform at /path/to/design.vcd, then analyze signal activity between t=4200000 and t=4220000. What instructions is the CPU fetching and are there any anomalies?

### FST Support

FST files require `fst2vcd` (part of [GTKWave](https://gtkwave.sourceforge.net/)) to be installed and on your PATH.

---

## Extension Settings

| Setting | Default | Description |
|---|---|---|
| `hdlWaveAi.provider` | `anthropic` | LLM provider: `anthropic` or `openai-compatible` |
| `hdlWaveAi.anthropic.apiKey` | — | Anthropic API key |
| `hdlWaveAi.anthropic.model` | `claude-sonnet-4-6` | Anthropic model ID |
| `hdlWaveAi.openaiCompatible.baseUrl` | `http://localhost:11434/v1` | Base URL for OpenAI-compatible API |
| `hdlWaveAi.openaiCompatible.apiKey` | `ollama` | API key (any string works for Ollama) |
| `hdlWaveAi.openaiCompatible.model` | `qwen2.5-coder:32b` | Model name |
| `hdlWaveAi.waveform.useToolMode` | `true` | Use tool-calling (RAG) mode for waveform analysis |
| `hdlWaveAi.waveform.sampleStepSize` | `1` | Time step size for waveform sampling |
| `hdlWaveAi.waveform.maxTransitions` | `300` | Max transitions sent to the LLM in legacy mode (evenly sampled if exceeded) |
| `hdlWaveAi.waveform.defaultEndTime` | `10000` | Fallback end time when no VaporView markers are set |
| `hdlWaveAi.hdl.searchPaths` | `[]` | Extra absolute paths to search for HDL source files |
| `hdlWaveAi.hdl.maxModules` | `5` | Max HDL modules to include, ranked by relevance |
| `hdlWaveAi.hdl.maxCharsPerModule` | `4000` | Max characters per module before truncation |
| `hdlWaveAi.chat.conversational` | `true` | Keep prior exchanges in context |
| `hdlWaveAi.chat.maxHistory` | `20` | Max messages retained in conversational mode |

### Tuning for larger models

Models with bigger context windows (32b+) can handle more data. Increase these settings:

```json
"hdlWaveAi.waveform.maxTransitions": 1000,
"hdlWaveAi.hdl.maxModules": 10,
"hdlWaveAi.hdl.maxCharsPerModule": 8000
```

---

## Commands

| Command | Description |
|---|---|
| `HDL Wave AI: Open Chat` | Open the AI chat panel |
| `HDL Wave AI: Debug VaporView State` | Dump VaporView state to the Output channel for troubleshooting |

---

## Troubleshooting

**No waveform context / "No signals tracked yet"**
Add signals to VaporView before opening the chat. The extension reads whatever is currently displayed in the signal list.

**HDL context not found**
Either open your RTL directory as the VS Code workspace root, or add the path to `hdlWaveAi.hdl.searchPaths` in settings.

**LLM not responding / very slow**
For large VCDs with no markers set, the extension may sample many time steps. Set markers in VaporView to limit the time range, or increase `sampleStepSize`.

**Check the Output channel**
Run `HDL Wave AI: Debug VaporView State` and open the **HDL Wave AI** output channel (`View → Output`) to see what signals, URIs, and state are being read.

---

## License

AGPL-3.0 — see [LICENSE](https://github.com/andrewcapatina/hdl-wave-ai/blob/main/hdl-wave-ai/LICENSE).
