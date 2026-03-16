# Change Log

All notable changes to the "hdl-wave-ai" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.2.1] - 2026-03-16

### Added
- **Auto-decode instruction signals in snapshots** — signals matching instruction bus patterns (`inst`, `inst_s2`, `IDATA`, `IM_DATA`, `opcode`, etc.) are automatically decoded into assembly mnemonics inline. The model no longer needs to call `decode_instruction` explicitly — it gets exact opcodes (e.g. `addi a3, a3, -1`) directly in snapshot and transition results.

### Improved
- Instruction signal detection regex expanded to match pipeline stage variants (`inst_s2`, `inst_s3`), numbered data buses (`IDATA1`), and instruction memory outputs (`IM_DATA`)
- Debug logging for auto-decode: `[Decode]` entries in the output channel show which signals matched, ISA setting, and decode results

## [0.2.0] - 2026-03-16

### Added
- **Multi-ISA instruction decoding** via [Capstone](https://www.capstone-engine.org/) disassembly engine. Supports RISC-V (RV32/RV64), ARM (ARMv7/Thumb/AArch64), x86/x64, MIPS (32/64), PowerPC, and SPARC
- **`decode_instruction` tool** — available in both the VS Code extension and MCP server. Accepts hex instruction values and returns disassembled output with mnemonic, operands, and branch targets
- **`hdlWaveAi.isa` setting** — configure the ISA to match your design's CPU core (e.g. `rv32` for RISC-V, `mips32` for MIPS). Set to `none` to disable
- **7 new waveform query tools** for smarter RAG analysis (11 tools total):
  - `get_next_transition` / `get_prev_transition` — walk through events one at a time
  - `snapshot` — sample all signals at a single timestamp
  - `find_pattern` — search for specific signal values
  - `count_transitions` — gauge signal activity before fetching data
  - `get_edges` — return only rising/falling edges, filtering clock noise
  - `decode_instruction` — decode raw instruction values into assembly
- **Completions endpoint support** (`/v1/completions`) for TRT-LLM and other servers where `/v1/chat/completions` is broken. Formats prompts as ChatML with text-based tool call parsing
- **Prompt token budget** (`prompt.maxTokens` setting, default 28000) — three-phase truncation: tool history, then HDL modules, then user message
- **Dynamic tool loop rounds** (`toolLoop.maxRounds` setting) — auto-calculated from token budget (14 rounds for 28K, up to 30 for 128K+ models)
- **Automatic waveform file switching** — detects when VaporView's active file changes and rebuilds the index. Marker suggestion chips carry the file URI for correct cross-file analysis
- **Marker event self-tracking** — bypasses VaporView's stale `getViewerState` by tracking marker times directly from events

### Improved
- System prompt teaches efficient tool methodology: snapshot for state, find_pattern for searches, get_next/prev_transition for causality, decode_instruction for opcodes
- Pre-seeded data uses `snapshot` at time range boundaries instead of bulk `query_transitions` for 10 signals — cuts initial prompt from ~33K to ~8K tokens
- Final analysis prompt no longer re-injects HDL context, saving thousands of tokens
- Token estimation uses conservative `chars / 2.5` ratio for accurate ChatML + JSON budgeting

### Fixed
- Prompt exceeding `max_num_tokens` on TRT-LLM (32768) across all phases: initial prompt, tool loop rounds, and final analysis
- Wrong waveform file analyzed after switching between designs in VaporView
- VaporView `getViewerState` returning stale marker values
- Suggestion chip showing wrong time range due to race condition
- HDL context sent twice (initial prompt + final re-prompt) doubling token usage

## [0.1.2] - 2026-02-25

### Added
- Syntax highlighting for inline RTL code snippets — backtick-quoted Verilog is now highlighted with VS Code Dark+ colors when it contains RTL keywords

### Fixed
- VaporView `getOpenDocuments` API returning an array instead of an object — caused "No active document found" and empty context on all queries

## [0.1.1] - 2026-02-24

### Added
- Syntax highlighting for Verilog/SystemVerilog code blocks in chat (highlight.js with VS Code Dark+ colors)
- Chat scroll preservation during streaming
- Structured output template for LLM responses (System Overview, Key Events Timeline, Signal Correlations, Summary)

### Improved
- Enhanced system prompts with analysis methodology, RTL citation requirements, and concrete examples
- VaporView marker fallback for time range extraction
- Module deduplication in HDL collector
- Default `hdl.maxModules` increased from 5 to 10
- Real-time streaming in tool mode for the final response
- Waveform index builds from the full VCD file even when the signal tracker is empty

### Fixed
- Tool mode failing when tracker had 0 signals on initial load
- Time range not extracted for regular typed queries

## [0.1.0] - 2026-02-23

### Added
- AI chat panel for interactive hardware waveform analysis
- Support for VCD and FST waveform file formats
- RTL source context integration for AI-assisted verification
- RAG (tool-use) mode for analyzing large designs
- MCP server for integration with Claude Code, Claude Desktop, and other AI tools
- Signal selector UI and time analyzer popup
- Markdown rendering in chat responses
- Ollama Docker support for local LLM usage

### Fixed
- Ollama Dockerfile and MCP/chat bug fixes
