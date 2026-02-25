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
import * as vscode from 'vscode';
import * as fs from 'fs';
import { extractIdentifiers, extractModules, scoreModule, findHdlFilesInDir, ScoredModule } from './parser';

/**
 * Collect HDL context relevant to the given signal paths.
 *
 * Strategy:
 *  1. Extract identifier words from the VaporView signal paths.
 *  2. Search the VS Code workspace + any configured extra paths for HDL files.
 *  3. Parse each file into module blocks.
 *  4. Score each module by how many tracked identifiers it contains.
 *  5. Return the top-N modules formatted as markdown, up to maxCharsPerModule each.
 */
export async function collectHdlContextSmart(
    signals: string[],
    log: vscode.OutputChannel
): Promise<string | null> {
    const config = vscode.workspace.getConfiguration('hdlWaveAi');
    const extraPaths = config.get<string[]>('hdl.searchPaths', []);
    const maxModules = config.get<number>('hdl.maxModules', 10);
    const maxCharsPerModule = config.get<number>('hdl.maxCharsPerModule', 4000);

    log.appendLine(`[HDL] collectHdlContextSmart called with ${signals.length} signals`);
    if (signals.length === 0) {
        log.appendLine('[HDL] No signals to cross-reference — skipping HDL collection');
        return null;
    }

    const identifiers = extractIdentifiers(signals);
    log.appendLine(`[HDL] Cross-referencing against ${identifiers.size} identifiers: ${Array.from(identifiers).slice(0, 20).join(', ')}${identifiers.size > 20 ? '...' : ''}`);

    const scored: ScoredModule[] = [];

    // --- Workspace files ---
    const wsFiles = await vscode.workspace.findFiles('**/*.{v,sv,svh,vhd,vhdl}', '**/node_modules/**');
    log.appendLine(`[HDL] Workspace HDL files found: ${wsFiles.length}`);

    for (const uri of wsFiles) {
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const text = Buffer.from(bytes).toString('utf8');
            const relPath = vscode.workspace.asRelativePath(uri);
            const mods = extractModules(text);

            for (const mod of mods) {
                const s = scoreModule(mod, identifiers);
                if (s > 0) { scored.push({ filePath: relPath, mod, score: s }); }
            }
        } catch { /* skip unreadable files */ }
    }

    // --- Extra search paths ---
    for (const dir of extraPaths) {
        const files = findHdlFilesInDir(dir);
        log.appendLine(`[HDL] Extra path "${dir}": ${files.length} files`);

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

    if (scored.length === 0) {
        log.appendLine('[HDL] No relevant modules found (no identifier matches)');
        return null;
    }

    // Sort by score descending, deduplicate by module name (keep highest), take top maxModules
    scored.sort((a, b) => b.score - a.score);
    const seen = new Set<string>();
    const deduped = scored.filter(m => {
        if (seen.has(m.mod.name)) { return false; }
        seen.add(m.mod.name);
        return true;
    });
    const selected = deduped.slice(0, maxModules);
    log.appendLine(
        `[HDL] Selected ${selected.length}/${scored.length} modules: ` +
        selected.map(m => `${m.mod.name}(${m.score})`).join(', ')
    );

    const parts = [
        `## HDL Source (${selected.length} module${selected.length !== 1 ? 's' : ''}, ranked by relevance to tracked signals)`,
    ];

    for (const item of selected) {
        const content = item.mod.content.length > maxCharsPerModule
            ? item.mod.content.slice(0, maxCharsPerModule) + '\n// ... (truncated)'
            : item.mod.content;
        parts.push(`\n### ${item.filePath} — \`module ${item.mod.name}\` (score: ${item.score})\n\`\`\`verilog\n${content}\n\`\`\``);
    }

    return parts.join('\n');
}
