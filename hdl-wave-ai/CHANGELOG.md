# Change Log

All notable changes to the "hdl-wave-ai" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.1.5] - 2026-03-16

### Added
- **TRT-LLM / DGX Spark support** — tested with Qwen3-32B-FP4 on NVIDIA DGX Spark (GB10 Blackwell). Works via `/v1/completions` with ChatML formatting
- **Automatic waveform file switching** — detects when VaporView's active file changes and rebuilds the waveform index. No more stale data when switching between designs
- **Marker URI tracking** — suggestion chips carry the waveform file URI, ensuring the correct file is analyzed when multiple waveforms are open
- **Marker event self-tracking** — bypasses VaporView's `getViewerState` (which returns stale values) by tracking marker times directly from `onDidSetMarker` events with debouncing

### Fixed
- **Wrong file analyzed after switching waveforms** — marker clicks on a second waveform file now correctly rebuild the index from that file instead of reusing the stale index
- **Suggestion chip not updating** — VaporView `getViewerState` race condition worked around via self-tracking with debounce

## [0.1.4] - 2026-03-16

### Added
- **7 new waveform query tools** for smarter RAG analysis (10 tools total):
  - `get_next_transition` / `get_prev_transition` — walk through events one at a time instead of bulk queries
  - `snapshot` — sample all signals at a single timestamp (replaces repeated `get_value_at` calls)
  - `find_pattern` — search for specific signal values (e.g. "when does VALID go high?")
  - `count_transitions` — gauge signal activity before fetching data
  - `get_edges` — return only rising/falling edges, filtering clock noise
- **Completions endpoint support** (`/v1/completions`) for TRT-LLM and other servers where `/v1/chat/completions` is broken. Formats prompts as ChatML with text-based tool call parsing. Enable via `useCompletionsEndpoint` setting.
- **Prompt token budget** (`prompt.maxTokens` setting, default 28000) — automatically truncates HDL context, chat history, and tool results to fit within model context limits. Three-phase truncation: tool history first, then HDL modules, then user message.
- **Dynamic tool loop rounds** (`toolLoop.maxRounds` setting) — auto-calculated from token budget (`maxTokens / 2000`, clamped 5-30). Larger context models get more rounds for deeper analysis.
- New tools registered in both the VS Code extension and the standalone MCP server

### Improved
- System prompt updated with efficient tool usage methodology: snapshot at range boundaries, find_pattern for targeted searches, get_next/prev_transition for causality tracing
- Pre-seeded tool data uses `snapshot` at time range boundaries instead of bulk `query_transitions` for 10 signals — dramatically reduces initial prompt size
- Token estimation uses conservative `chars / 2.5` ratio for accurate ChatML + JSON budgeting
- Final analysis prompt no longer re-injects HDL context (already in conversation), saving thousands of tokens
- Tool definitions and results are trimmed from oldest entries when prompt exceeds budget

### Fixed
- Prompt exceeding `max_num_tokens` on TRT-LLM (32768) — budget enforcement now covers initial prompt assembly, tool loop rounds, and final analysis prompt
- HDL context sent twice (initial prompt + final re-prompt) doubling token usage

## [0.1.2] - 2026-02-25

### Added
- Syntax highlighting for inline RTL code snippets — backtick-quoted Verilog (e.g. `` `assign X = Y ? A : B;` ``) is now highlighted with VS Code Dark+ colors when it contains RTL keywords

### Fixed
- VaporView `getOpenDocuments` API returning an array instead of an object — caused "No active document found" and empty context on all queries

## [0.1.1] - 2026-02-24

### Added
- Syntax highlighting for Verilog/SystemVerilog code blocks in chat (highlight.js with VS Code Dark+ colors)
- Chat scroll preservation during streaming — scroll up to read earlier messages without being pulled to the bottom
- Structured output template for LLM responses (System Overview, Key Events Timeline, Signal Correlations, Summary)

### Improved
- Enhanced system prompts with analysis methodology, RTL citation requirements, and concrete examples
- HDL context re-injected in the final LLM re-prompt to prevent source from being lost in long conversations
- VaporView marker fallback for time range extraction when no explicit range is in the query
- Module deduplication in HDL collector to prevent duplicates from consuming context slots
- Default `hdl.maxModules` increased from 5 to 10
- Real-time streaming in tool mode for the final response
- Waveform index builds from the full VCD file even when the signal tracker is empty

### Fixed
- Tool mode failing when tracker had 0 signals on initial load
- Time range not extracted for regular typed queries (only worked for marker suggestion clicks)

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