/*
    Copyright (C) 2026 Andrew Capatina

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as
    published by the Free Software Foundation, either version 3 of the
    License, or (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.

    You should have received a copy of the GNU Affero General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { WaveformIndex } from "../waveform/vcd";
import { parseWaveformFile } from "../waveform/fst";
import { findRelevantModules } from "../hdl/parser";
import * as fs from "fs";

let waveformIndex: WaveformIndex | null = null;

const TRANSITION_CAP = 150;

const server = new McpServer({
    name: "hdl-wave-ai",
    version: "0.1.0",
});

// ── load_waveform ────────────────────────────────────────────────────────────

server.registerTool(
    "load_waveform",
    {
        description: "Load a VCD or FST waveform file for analysis. Replaces any previously loaded waveform.",
        inputSchema: {
            file_path: z.string().describe("Absolute path to a .vcd or .fst file"),
        },
    },
    async ({ file_path }) => {
        if (!fs.existsSync(file_path)) {
            return { content: [{ type: "text" as const, text: `File not found: ${file_path}` }] };
        }
        const result = await parseWaveformFile(file_path);
        waveformIndex = new WaveformIndex({
            ...result,
            uri: file_path,
            startTime: 0,
        });
        const text =
            `Loaded ${file_path}\n` +
            `  Signals: ${waveformIndex.signals.length}\n` +
            `  Transitions: ${result.transitions.length}\n` +
            `  Time range: 0 – ${waveformIndex.endTime}\n` +
            `  Timescale: ${waveformIndex.timescale}`;
        console.error(text);
        return { content: [{ type: "text" as const, text }] };
    }
);

// ── list_signals ─────────────────────────────────────────────────────────────

server.registerTool(
    "list_signals",
    {
        description: "List all signals in the loaded waveform with their transition counts.",
        inputSchema: {},
    },
    async () => {
        if (!waveformIndex) {
            return { content: [{ type: "text" as const, text: "No waveform loaded. Call load_waveform first." }] };
        }
        const signals = waveformIndex.listSignals();
        return { content: [{ type: "text" as const, text: JSON.stringify(signals, null, 2) }] };
    }
);

// ── query_transitions ────────────────────────────────────────────────────────

server.registerTool(
    "query_transitions",
    {
        description: "Get transitions for a signal within a time range. Returns up to 150 transitions; narrow the range if capped.",
        inputSchema: {
            signal: z.string().describe("Full signal name as returned by list_signals"),
            t_start: z.number().describe("Start timestamp (inclusive)"),
            t_end: z.number().describe("End timestamp (inclusive)"),
        },
    },
    async ({ signal, t_start, t_end }) => {
        if (!waveformIndex) {
            return { content: [{ type: "text" as const, text: "No waveform loaded. Call load_waveform first." }] };
        }
        const transitions = waveformIndex.queryTransitions(signal, t_start, t_end, TRANSITION_CAP);
        if (transitions.length === 0) {
            return { content: [{ type: "text" as const, text: `No transitions for "${signal}" in [${t_start}, ${t_end}].` }] };
        }
        const note = transitions.length >= TRANSITION_CAP
            ? `[Capped at ${TRANSITION_CAP}. Narrow the range for more detail.]\n` : "";
        const text = note + transitions.map(t => `t=${t.time}: ${t.value}`).join("\n");
        return { content: [{ type: "text" as const, text }] };
    }
);

// ── get_value_at ─────────────────────────────────────────────────────────────

server.registerTool(
    "get_value_at",
    {
        description: "Get the value of a signal at or before a specific timestamp.",
        inputSchema: {
            signal: z.string().describe("Full signal name"),
            time: z.number().describe("Timestamp to query"),
        },
    },
    async ({ signal, time }) => {
        if (!waveformIndex) {
            return { content: [{ type: "text" as const, text: "No waveform loaded. Call load_waveform first." }] };
        }
        const value = waveformIndex.getValueAt(signal, time);
        return { content: [{ type: "text" as const, text: `"${signal}" at t=${time}: ${value}` }] };
    }
);

// ── find_hdl_modules ─────────────────────────────────────────────────────────

server.registerTool(
    "find_hdl_modules",
    {
        description: "Search directories for Verilog/SystemVerilog source files and return the modules most relevant to the loaded waveform signals. Ranks modules by how many signal identifiers appear in the source.",
        inputSchema: {
            search_paths: z.array(z.string()).describe("Absolute directory paths to search for .v/.sv/.svh files"),
            max_modules: z.number().optional().describe("Max modules to return (default 5)"),
            max_chars_per_module: z.number().optional().describe("Max characters per module (default 4000)"),
        },
    },
    async ({ search_paths, max_modules, max_chars_per_module }) => {
        const signals = waveformIndex ? waveformIndex.signals : [];
        const result = findRelevantModules(
            search_paths,
            signals,
            max_modules ?? 5,
            max_chars_per_module ?? 4000,
        );
        if (!result) {
            return { content: [{ type: "text" as const, text: "No relevant HDL modules found. Check that the search paths contain .v/.sv files and a waveform is loaded for relevance ranking." }] };
        }
        return { content: [{ type: "text" as const, text: result }] };
    }
);

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
    const filePath = process.argv[2];
    if (filePath) {
        if (!fs.existsSync(filePath)) {
            console.error(`File not found: ${filePath}`);
            process.exit(1);
        }
        console.error(`Loading waveform: ${filePath}`);
        const result = await parseWaveformFile(filePath);
        waveformIndex = new WaveformIndex({
            ...result,
            uri: filePath,
            startTime: 0,
        });
        console.error(`Loaded: ${waveformIndex.signals.length} signals, ${result.transitions.length} transitions`);
    }

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("HDL Wave AI MCP Server running on stdio");
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
