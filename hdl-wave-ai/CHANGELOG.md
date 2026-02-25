# Change Log

All notable changes to the "hdl-wave-ai" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

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