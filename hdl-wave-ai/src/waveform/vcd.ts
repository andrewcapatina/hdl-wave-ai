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
// Defined here (not in vaporview/api) to avoid a circular import.
// vaporview/api.ts re-exports this type so callers are unaffected.
export interface SignalTransition {
    time: number;
    signal: string;
    value: string;
}

interface VcdSignal {
    id: string;
    path: string;    // e.g. "tb.dut.counter"
    width: number;
}

export interface VcdParseResult {
    /** Hierarchical signal paths that had at least one transition */
    signals: string[];
    transitions: SignalTransition[];
    endTime: number;
    timescale: string;
}

// Format a binary/x/z string with hex annotation for multi-bit signals
function formatBits(bits: string, width: number): string {
    if (width <= 1) { return bits; }
    // Pad to declared width
    const padded = bits.padStart(width, bits[0] === 'x' || bits[0] === 'X' ? 'x' : '0');
    if (/^[01]+$/.test(padded)) {
        const hex = parseInt(padded, 2).toString(16).toUpperCase();
        return `${padded} (0x${hex})`;
    }
    return padded; // contains x/z — no hex conversion
}

export function parseVcd(content: string): VcdParseResult {
    const signalDefs = new Map<string, VcdSignal>();  // id → signal
    const scopeStack: string[] = [];
    let timescale = '1 ns';
    let currentTime = 0;
    let endTime = 0;
    const transitions: SignalTransition[] = [];
    const lastValues = new Map<string, string>();
    const signalsWithTransitions = new Set<string>();

    let i = 0;
    const lines = content.split('\n');
    const total = lines.length;

    // Helper: collect tokens until $end, spanning multiple lines if needed
    function collectUntilEnd(startLine: string): string {
        let text = startLine;
        while (!text.includes('$end') && i < total) {
            text += ' ' + lines[i++].trim();
        }
        return text.replace(/\$end\b.*/, '').trim();
    }

    // ── Header ────────────────────────────────────────────────────────────────
    while (i < total) {
        const raw = lines[i++];
        const line = raw.trim();
        if (!line) { continue; }

        if (line.startsWith('$timescale')) {
            const body = collectUntilEnd(line.replace('$timescale', '').trim());
            timescale = body.trim() || timescale;
            continue;
        }

        if (line.startsWith('$scope')) {
            // $scope module name $end  (may span lines)
            const full = collectUntilEnd(line);
            const m = full.match(/\$scope\s+\w+\s+(\S+)/);
            if (m) { scopeStack.push(m[1]); }
            continue;
        }

        if (line.startsWith('$upscope')) {
            scopeStack.pop();
            continue;
        }

        if (line.startsWith('$var')) {
            // $var type width id name [bit_range] $end
            const full = collectUntilEnd(line);
            const m = full.match(/\$var\s+\S+\s+(\d+)\s+(\S+)\s+(\S+)/);
            if (m) {
                const width = parseInt(m[1], 10);
                const id = m[2];
                const name = m[3].replace(/\[.*\]$/, ''); // strip trailing [n:m]
                const path = [...scopeStack, name].join('.');
                // If duplicate id (e.g. aliased signal), last definition wins
                signalDefs.set(id, { id, path, width });
            }
            continue;
        }

        if (line.startsWith('$enddefinitions')) {
            // Skip to $end if on same line, otherwise consume lines
            if (!line.includes('$end')) {
                while (i < total && !lines[i].includes('$end')) { i++; }
                i++; // consume the $end line
            }
            break; // header done
        }

        // Skip all other $blocks ($comment, $version, $date)
        if (line.startsWith('$') && !line.includes('$end')) {
            while (i < total && !lines[i].includes('$end')) { i++; }
            i++;
        }
    }

    // ── Data section ──────────────────────────────────────────────────────────
    let skipToEnd = false;  // inside $dumpvars / $dumpall / etc.

    while (i < total) {
        const raw = lines[i++];
        const line = raw.trim();
        if (!line) { continue; }

        // Skip command blocks that wrap value changes ($dumpvars, $dumpall, …)
        if (line.startsWith('$')) {
            if (line.includes('$end')) {
                skipToEnd = false;
            } else {
                skipToEnd = true;
            }
            continue;
        }
        if (skipToEnd) { continue; }

        // Timestamp
        if (line.startsWith('#')) {
            currentTime = parseInt(line.slice(1), 10);
            if (currentTime > endTime) { endTime = currentTime; }
            continue;
        }

        // Vector change: b<bits> <id>  or  B<bits> <id>
        if (line[0] === 'b' || line[0] === 'B') {
            const sp = line.indexOf(' ');
            if (sp > 0) {
                const bits = line.slice(1, sp);
                const id = line.slice(sp + 1).trim();
                const sig = signalDefs.get(id);
                if (sig) {
                    const formatted = formatBits(bits, sig.width);
                    if (lastValues.get(sig.path) !== formatted) {
                        transitions.push({ time: currentTime, signal: sig.path, value: formatted });
                        lastValues.set(sig.path, formatted);
                        signalsWithTransitions.add(sig.path);
                    }
                }
            }
            continue;
        }

        // Real value change: r<num> <id> — represent as a string
        if (line[0] === 'r' || line[0] === 'R') {
            const sp = line.indexOf(' ');
            if (sp > 0) {
                const val = line.slice(1, sp);
                const id = line.slice(sp + 1).trim();
                const sig = signalDefs.get(id);
                if (sig) {
                    if (lastValues.get(sig.path) !== val) {
                        transitions.push({ time: currentTime, signal: sig.path, value: val });
                        lastValues.set(sig.path, val);
                        signalsWithTransitions.add(sig.path);
                    }
                }
            }
            continue;
        }

        // Scalar change: <0|1|x|X|z|Z><id>
        if (line.length >= 2 && '01xXzZ'.includes(line[0])) {
            const val = line[0].toLowerCase();
            const id = line.slice(1).trim();
            const sig = signalDefs.get(id);
            if (sig) {
                if (lastValues.get(sig.path) !== val) {
                    transitions.push({ time: currentTime, signal: sig.path, value: val });
                    lastValues.set(sig.path, val);
                    signalsWithTransitions.add(sig.path);
                }
            }
            continue;
        }
    }

    return {
        signals: Array.from(signalsWithTransitions),
        transitions,
        endTime,
        timescale,
    };
}

/**
 * In-memory index over a parsed waveform for efficient LLM tool queries.
 * Accepts any object with signals/transitions/endTime (VcdParseResult or WaveformContext).
 */
export class WaveformIndex {
    private bySignal: Map<string, SignalTransition[]>;
    readonly signals: string[];
    readonly timescale: string;
    readonly endTime: number;
    readonly startTime: number;
    readonly uri: string;

    constructor(data: {
        signals: string[];
        transitions: SignalTransition[];
        endTime: number;
        startTime?: number;
        timescale?: string;
        uri?: string;
    }) {
        this.signals = data.signals;
        this.timescale = data.timescale ?? 'unknown';
        this.endTime = data.endTime;
        this.startTime = data.startTime ?? 0;
        this.uri = data.uri ?? '';

        this.bySignal = new Map();
        for (const t of data.transitions) {
            let bucket = this.bySignal.get(t.signal);
            if (!bucket) { bucket = []; this.bySignal.set(t.signal, bucket); }
            bucket.push(t);
        }
    }

    listSignals(): { name: string; transitionCount: number }[] {
        return this.signals.map(name => ({
            name,
            transitionCount: this.bySignal.get(name)?.length ?? 0,
        }));
    }

    queryTransitions(signal: string, tStart: number, tEnd: number, cap = 150): SignalTransition[] {
        const ts = this.bySignal.get(signal) ?? [];
        const filtered = ts.filter(t => t.time >= tStart && t.time <= tEnd);
        if (filtered.length <= cap) { return filtered; }
        const step = filtered.length / cap;
        return Array.from({ length: cap }, (_, i) => filtered[Math.round(i * step)]);
    }

    getValueAt(signal: string, time: number): string {
        const ts = this.bySignal.get(signal) ?? [];
        let lo = 0, hi = ts.length - 1, result = 'x';
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (ts[mid].time <= time) { result = ts[mid].value; lo = mid + 1; }
            else { hi = mid - 1; }
        }
        return result;
    }
}