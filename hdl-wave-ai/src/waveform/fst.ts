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
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import { parseVcd, VcdParseResult } from './vcd';

const execFileAsync = promisify(execFile);

/**
 * Convert an FST file to VCD text using the fst2vcd command-line tool
 * (included with GTKWave: `sudo apt install gtkwave`).
 */
export async function fstToVcdText(fstPath: string): Promise<string> {
    try {
        const { stdout } = await execFileAsync('fst2vcd', [fstPath], {
            maxBuffer: 200 * 1024 * 1024,  // 200 MB
        });
        if (!stdout) {
            throw new Error('fst2vcd produced no output — the file may be empty or corrupt');
        }
        return stdout;
    } catch (err: unknown) {
        const e = err as { code?: string; message?: string };
        if (e.code === 'ENOENT') {
            throw new Error(
                'fst2vcd not found. Install GTKWave to enable FST support:\n' +
                '  sudo apt install gtkwave'
            );
        }
        throw new Error(`fst2vcd failed: ${e.message ?? String(err)}`);
    }
}

/**
 * Parse a waveform file (.fst or .vcd) and return the structured result.
 * FST files are converted to VCD via fst2vcd before parsing.
 */
export async function parseWaveformFile(filePath: string): Promise<VcdParseResult> {
    const ext = filePath.toLowerCase();

    if (ext.endsWith('.fst')) {
        const vcdText = await fstToVcdText(filePath);
        return parseVcd(vcdText);
    }

    if (ext.endsWith('.vcd')) {
        const vcdText = fs.readFileSync(filePath, 'utf8');
        return parseVcd(vcdText);
    }

    throw new Error(`Unsupported waveform format. Expected .fst or .vcd, got: ${filePath}`);
}