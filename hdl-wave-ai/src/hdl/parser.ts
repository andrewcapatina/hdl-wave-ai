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
import * as path from 'path';
import * as fs from 'fs';

export interface HdlModule {
    name: string;
    content: string;
}

export interface ScoredModule {
    filePath: string;
    mod: HdlModule;
    score: number;
}

/**
 * Extract unique identifier words from signal paths.
 * e.g. "tb.dut.alu.result" -> { 'tb', 'dut', 'alu', 'result' }
 */
export function extractIdentifiers(signalPaths: string[]): Set<string> {
    const ids = new Set<string>();
    for (const sig of signalPaths) {
        const clean = sig.replace(/\[[\d:]+\]/g, '');
        for (const part of clean.split('.')) {
            if (part.length > 1) { ids.add(part); }
        }
    }
    return ids;
}

/**
 * Extract module...endmodule blocks from Verilog/SystemVerilog source.
 */
export function extractModules(text: string): HdlModule[] {
    const modules: HdlModule[] = [];
    const regex = /\bmodule\s+(\w+)[\s\S]*?\bendmodule\b/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
        modules.push({ name: match[1], content: match[0] });
    }
    return modules;
}

/**
 * Score a module by how many tracked identifiers appear in it.
 */
export function scoreModule(mod: HdlModule, identifiers: Set<string>): number {
    let score = 0;
    for (const id of identifiers) {
        if (new RegExp(`\\b${id}\\b`).test(mod.content)) { score++; }
    }
    return score;
}

/** Recursively find HDL files under an absolute directory path. */
export function findHdlFilesInDir(dir: string): string[] {
    const results: string[] = [];
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory() && !entry.name.startsWith('.')) {
                results.push(...findHdlFilesInDir(full));
            } else if (entry.isFile() && /\.(v|sv|svh|vhd|vhdl)$/i.test(entry.name)) {
                results.push(full);
            }
        }
    } catch { /* skip unreadable dirs */ }
    return results;
}

/**
 * Search directories for HDL modules relevant to the given signal names.
 * Returns top-N modules scored by identifier overlap, formatted as markdown.
 */
export function findRelevantModules(
    searchPaths: string[],
    signals: string[],
    maxModules = 5,
    maxCharsPerModule = 4000,
): string | null {
    if (signals.length === 0 || searchPaths.length === 0) {
        return null;
    }

    const identifiers = extractIdentifiers(signals);
    const scored: ScoredModule[] = [];

    for (const dir of searchPaths) {
        if (!fs.existsSync(dir)) { continue; }
        const files = findHdlFilesInDir(dir);
        for (const filePath of files) {
            try {
                const text = fs.readFileSync(filePath, 'utf8');
                for (const mod of extractModules(text)) {
                    const s = scoreModule(mod, identifiers);
                    if (s > 0) { scored.push({ filePath, mod, score: s }); }
                }
            } catch { /* skip */ }
        }
    }

    if (scored.length === 0) { return null; }

    scored.sort((a, b) => b.score - a.score);
    const selected = scored.slice(0, maxModules);

    const parts = [
        `## HDL Source (${selected.length} module${selected.length !== 1 ? 's' : ''}, ranked by relevance)`,
    ];
    for (const item of selected) {
        const content = item.mod.content.length > maxCharsPerModule
            ? item.mod.content.slice(0, maxCharsPerModule) + '\n// ... (truncated)'
            : item.mod.content;
        parts.push(`\n### ${item.filePath} — \`module ${item.mod.name}\` (score: ${item.score})\n\`\`\`verilog\n${content}\n\`\`\``);
    }
    return parts.join('\n');
}