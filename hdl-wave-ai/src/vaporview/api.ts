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
import { SignalTransition } from '../waveform/vcd';
import { parseWaveformFile } from '../waveform/fst';
export { SignalTransition } from '../waveform/vcd';

export interface WaveformContext {
    uri: string;
    signals: string[];
    transitions: SignalTransition[];
    startTime: number;
    endTime: number;
}

// Tracks signals currently displayed in VaporView via events
export class SignalTracker {
    private signals: Map<string, Set<string>> = new Map(); // uri -> instancePaths
    private disposables: vscode.Disposable[] = [];
    readonly log: vscode.OutputChannel;

    constructor(log: vscode.OutputChannel) {
        this.log = log;
        this.subscribeToEvents();
    }

    private uriKey(uri: string | vscode.Uri | { fsPath?: string }): string {
        if (typeof uri === 'string') { return uri; }
        if (typeof (uri as vscode.Uri).toString === 'function') { return (uri as vscode.Uri).toString(); }
        return (uri as { fsPath?: string }).fsPath ?? String(uri);
    }

    private subscribeToEvents() {
        const addDisposable = vscode.extensions
            .getExtension('lramseyer.vaporview')
            ?.exports
            ?.onDidAddVariable((e: { uri: string | { external?: string; fsPath?: string }; instancePath: string }) => {
                this.log.appendLine(`[VaporView] onDidAddVariable: ${JSON.stringify(e)}`);
                const key = this.uriKey(e.uri);
                if (!this.signals.has(key)) {
                    this.signals.set(key, new Set());
                }
                this.signals.get(key)!.add(e.instancePath);
            });

        const removeDisposable = vscode.extensions
            .getExtension('lramseyer.vaporview')
            ?.exports
            ?.onDidRemoveVariable((e: { uri: string | { external?: string; fsPath?: string }; instancePath: string }) => {
                this.log.appendLine(`[VaporView] onDidRemoveVariable: ${JSON.stringify(e)}`);
                const key = this.uriKey(e.uri);
                this.signals.get(key)?.delete(e.instancePath);
            });

        if (addDisposable) { this.disposables.push(addDisposable); }
        if (removeDisposable) { this.disposables.push(removeDisposable); }
    }

    getSignals(uri: string): string[] {
        const keys = Array.from(this.signals.keys());
        this.log.appendLine(`[Tracker] getSignals lookup: "${uri}"`);
        this.log.appendLine(`[Tracker] map keys: ${JSON.stringify(keys)}`);
        this.log.appendLine(`[Tracker] map size: ${this.signals.size}`);
        return Array.from(this.signals.get(uri) ?? []);
    }

    async initialize(): Promise<void> {
        try {
            const docs = await vscode.commands.executeCommand<{
                documents: string[];
                lastActiveDocument: string;
            }>('waveformViewer.getOpenDocuments');

            if (!docs?.documents?.length) { return; }

            for (const uri of docs.documents) {
                const state = await vscode.commands.executeCommand<{
                    displayedSignals: Array<Record<string, unknown>>;
                }>('waveformViewer.getViewerState', { uri });

                this.log.appendLine(`[Tracker] initialize displayedSignals for ${uri}: ${JSON.stringify(state?.displayedSignals)}`);

                if (!state?.displayedSignals?.length) { continue; }

                if (!this.signals.has(uri)) {
                    this.signals.set(uri, new Set());
                }

                for (const sig of state.displayedSignals) {
                    const path = (sig['instancePath'] ?? sig['name']) as string | undefined;
                    if (path) {
                        this.signals.get(uri)!.add(path);
                    }
                }
            }
        } catch (err) {
            this.log.appendLine(`[Tracker] initialize error: ${err}`);
        }
    }

    dispose() {
        for (const d of this.disposables) { d.dispose(); }
    }
}

export async function getActiveDocumentUri(log: vscode.OutputChannel): Promise<string | null> {
    const docs = await vscode.commands.executeCommand<{ lastActiveDocument: string }>(
        'waveformViewer.getOpenDocuments'
    );
    log.appendLine(`[VaporView] getOpenDocuments: ${JSON.stringify(docs)}`);
    return docs?.lastActiveDocument ?? null;
}

const MAX_SAMPLE_ITERATIONS = 100;
const EARLY_EXIT_EMPTY_STREAK = 5;    // stop if VaporView returns empty N times in a row
const EARLY_EXIT_NO_CHANGE_STREAK = 5; // stop if no new transitions for N consecutive samples (held values past sim end)

export async function collectTransitions(
    uri: string,
    signals: string[],
    startTime: number,
    endTime: number,
    stepSize: number,
    log: vscode.OutputChannel,
    signal?: AbortSignal
): Promise<SignalTransition[]> {
    const transitions: SignalTransition[] = [];
    const lastValues: Record<string, string> = {};

    // Strip bit range notation for the query (e.g. "sig[3:0]" -> "sig")
    const queryPaths = signals.map(s => s.replace(/\[[\d:]+\]$/, ''));

    // Cap total API calls to avoid hanging when no markers are set and the
    // time range is large (e.g. stepSize=1, endTime=100000 → 100k calls)
    const range = endTime - startTime;
    const effectiveStep = range > 0 && Math.ceil(range / stepSize) > MAX_SAMPLE_ITERATIONS
        ? Math.ceil(range / MAX_SAMPLE_ITERATIONS)
        : stepSize;

    if (effectiveStep !== stepSize) {
        log.appendLine(`[Transitions] Step size auto-adjusted: ${stepSize} → ${effectiveStep} (capped at ${MAX_SAMPLE_ITERATIONS} iterations over range ${range})`);
    }

    log.appendLine(`[Transitions] Collecting from t=${startTime} to t=${endTime}, step=${effectiveStep}, ${signals.length} signals`);
    let emptyStreak = 0;
    let noChangeStreak = 0;
    let samplesWithData = 0;

    for (let time = startTime; time <= endTime; time += effectiveStep) {
        if (signal?.aborted) {
            log.appendLine('[Transitions] Collection aborted by user');
            break;
        }

        const raw = await vscode.commands.executeCommand<Array<{ instancePath: string; value: string }>>(
            'waveformViewer.getValuesAtTime',
            { uri, time, instancePaths: queryPaths }
        );

        if (!raw || !Array.isArray(raw) || raw.length === 0) {
            emptyStreak++;
            if (emptyStreak >= EARLY_EXIT_EMPTY_STREAK) {
                log.appendLine(`[Transitions] Early exit at t=${time}: ${emptyStreak} consecutive empty responses`);
                break;
            }
            continue;
        }
        emptyStreak = 0;
        samplesWithData++;

        if (time === startTime) {
            log.appendLine(`[Transitions] Raw values at t=${time}: ${JSON.stringify(raw)}`);
        }

        const prevCount = transitions.length;
        let anyExactTransition = false;

        for (const entry of raw) {
            const sig = entry.instancePath;

            // value is [current] or [previous, current] — handle both JSON string
            // and actual array (API may return either depending on VaporView version)
            let parsed: unknown;
            if (typeof (entry as { value: unknown }).value === 'string') {
                try { parsed = JSON.parse(entry.value); } catch { parsed = entry.value; }
            } else {
                parsed = (entry as { value: unknown }).value;
            }

            // Always take the LAST element as the current value
            // (length-1 array: [current]; length-2 array: [previous, current])
            let bits: string;
            if (Array.isArray(parsed)) {
                if (parsed.length === 2) { anyExactTransition = true; }
                bits = String(parsed[parsed.length - 1]);
            } else {
                bits = String(parsed);
            }

            const strValue = /^[01]+$/.test(bits) && bits.length > 1
                ? `${bits} (0x${parseInt(bits, 2).toString(16).toUpperCase()})`
                : bits;

            if (lastValues[sig] !== strValue) {
                transitions.push({ time, signal: sig, value: strValue });
                lastValues[sig] = strValue;
            }
        }

        // Two complementary end-of-simulation detectors:
        // 1. No exact transitions (value.length===2) — reliable when step aligns with clock
        // 2. No value changes vs lastValues — reliable across any step size
        const noChangeThisSample = transitions.length === prevCount;
        if ((noChangeThisSample || !anyExactTransition) && samplesWithData > 1) {
            noChangeStreak++;
            if (noChangeStreak >= EARLY_EXIT_NO_CHANGE_STREAK) {
                log.appendLine(`[Transitions] Early exit at t=${time}: ${noChangeStreak} consecutive no-change samples (past simulation end)`);
                break;
            }
        } else {
            noChangeStreak = 0;
        }
    }

    log.appendLine(`[VaporView] collected ${transitions.length} transitions`);
    return transitions;
}

/**
 * Build context by parsing the waveform file directly (FST or VCD).
 * Returns null if parsing fails — caller falls back to VaporView API polling.
 */
async function buildWaveformContextFromFile(
    uri: string,
    trackedSignals: string[],
    mainMarker: number | null,
    altMarker: number | null,
    defaultStart: number,
    defaultEnd: number,
    log: vscode.OutputChannel,
    abortSignal?: AbortSignal
): Promise<WaveformContext | null> {
    const filePath = vscode.Uri.parse(uri).fsPath;
    log.appendLine(`[WaveformContext] Parsing file directly: ${filePath}`);

    let parseResult: import('../waveform/vcd').VcdParseResult;
    try {
        parseResult = await parseWaveformFile(filePath);
    } catch (err) {
        log.appendLine(`[WaveformContext] File parse failed (${err}), falling back to VaporView API`);
        return null;
    }

    if (abortSignal?.aborted) { return null; }

    // Resolve time range using markers (same logic as polling path)
    let resolvedStart: number;
    let resolvedEnd: number;

    if (mainMarker !== null && altMarker !== null) {
        resolvedStart = Math.min(mainMarker, altMarker);
        resolvedEnd   = Math.max(mainMarker, altMarker);
    } else if (mainMarker !== null) {
        resolvedStart = defaultStart;
        resolvedEnd   = mainMarker;
    } else if (altMarker !== null) {
        resolvedStart = defaultStart;
        resolvedEnd   = altMarker;
    } else {
        resolvedStart = defaultStart;
        resolvedEnd   = parseResult.endTime || defaultEnd;
    }

    // Build a lookup of normalized signal names (strip [N:M] bit ranges)
    // Tracker:  "tb.count[7:0]"  →  VCD parser:  "tb.count"
    const normToTracked = new Map<string, string>();
    for (const sig of trackedSignals) {
        normToTracked.set(sig.replace(/\[[\d:]+\]$/, ''), sig);
    }

    // Filter parsed transitions to selected signals and resolved time range
    const filtered: SignalTransition[] = [];
    for (const t of parseResult.transitions) {
        if (t.time < resolvedStart || t.time > resolvedEnd) { continue; }
        const trackedName = normToTracked.get(t.signal);
        if (trackedName !== undefined) {
            filtered.push({ time: t.time, signal: trackedName, value: t.value });
        }
    }

    log.appendLine(
        `[WaveformContext] File parse: ${parseResult.transitions.length} total → ` +
        `${filtered.length} filtered (t=${resolvedStart}–${resolvedEnd}, ` +
        `timescale=${parseResult.timescale})`
    );

    return { uri, signals: trackedSignals, transitions: filtered, startTime: resolvedStart, endTime: resolvedEnd };
}

export async function buildWaveformContext(
    tracker: SignalTracker,
    startTime: number,
    endTime: number,
    stepSize: number,
    signal?: AbortSignal
): Promise<WaveformContext | null> {
    const uri = await getActiveDocumentUri(tracker.log);
    if (!uri) {
        tracker.log.appendLine('[WaveformContext] No active document found');
        return null;
    }

    const signals = tracker.getSignals(uri);
    tracker.log.appendLine(`[WaveformContext] Signals from tracker: ${JSON.stringify(signals)}`);

    if (signals.length === 0) {
        tracker.log.appendLine('[WaveformContext] No signals tracked yet — add signals to VaporView first');
        return null;
    }

    // Use marker positions from VaporView if set, otherwise use provided range
    const state = await vscode.commands.executeCommand<{
        markerTime: number | null;
        altMarkerTime: number | null;
        timeEnd: number | null;
        maxTime: number | null;
        totalTime: number | null;
    }>('waveformViewer.getViewerState', { uri });

    const mainMarker = (state?.markerTime !== null && state?.markerTime !== undefined) ? state.markerTime : null;
    const altMarker  = (state?.altMarkerTime !== null && state?.altMarkerTime !== undefined) ? state.altMarkerTime : null;

    // For FST / VCD files: parse directly — avoids the coarse step-size problem
    // when VaporView doesn't expose the simulation end time.
    const lowerUri = uri.toLowerCase();
    if (lowerUri.endsWith('.fst') || lowerUri.endsWith('.vcd')) {
        const fileCtx = await buildWaveformContextFromFile(
            uri, signals, mainMarker, altMarker, startTime, endTime, tracker.log, signal
        );
        if (fileCtx) { return fileCtx; }
        // File parse failed — fall through to VaporView polling
    }

    // ── VaporView polling fallback (non-FST/VCD or file parse error) ──────────
    const vcdEnd = state?.timeEnd ?? state?.maxTime ?? state?.totalTime ?? null;

    let resolvedStart: number;
    let resolvedEnd: number;

    if (mainMarker !== null && altMarker !== null) {
        resolvedStart = Math.min(mainMarker, altMarker);
        resolvedEnd   = Math.max(mainMarker, altMarker);
    } else if (mainMarker !== null) {
        resolvedStart = startTime;
        resolvedEnd   = mainMarker;
    } else if (altMarker !== null) {
        resolvedStart = startTime;
        resolvedEnd   = altMarker;
    } else {
        resolvedStart = startTime;
        resolvedEnd   = vcdEnd ?? endTime;
    }

    tracker.log.appendLine(`[WaveformContext] mainMarker=${mainMarker}, altMarker=${altMarker}, vcdEnd=${vcdEnd}, time range: ${resolvedStart} – ${resolvedEnd}`);

    const transitions = await collectTransitions(uri, signals, resolvedStart, resolvedEnd, stepSize, tracker.log, signal);
    return { uri, signals, transitions, startTime: resolvedStart, endTime: resolvedEnd };
}
