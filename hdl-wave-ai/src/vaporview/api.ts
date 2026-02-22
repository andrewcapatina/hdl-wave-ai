import * as vscode from 'vscode';

export interface SignalTransition {
    time: number;
    signal: string;
    value: string;
}

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

export async function collectTransitions(
    uri: string,
    signals: string[],
    startTime: number,
    endTime: number,
    stepSize: number,
    log: vscode.OutputChannel
): Promise<SignalTransition[]> {
    const transitions: SignalTransition[] = [];
    const lastValues: Record<string, string> = {};

    // Strip bit range notation for the query (e.g. "sig[3:0]" -> "sig")
    // but keep a map back to the original display name
    const queryPaths = signals.map(s => s.replace(/\[[\d:]+\]$/, ''));

    log.appendLine(`[Transitions] Collecting from t=${startTime} to t=${endTime}, ${signals.length} signals`);
    for (let time = startTime; time <= endTime; time += stepSize) {
        const raw = await vscode.commands.executeCommand<Array<{ instancePath: string; value: string }>>(
            'waveformViewer.getValuesAtTime',
            { uri, time, instancePaths: queryPaths }
        );

        if (!raw || !Array.isArray(raw)) { continue; }

        if (time === startTime) {
            log.appendLine(`[Transitions] Raw values at t=${time}: ${JSON.stringify(raw)}`);
        }

        for (const entry of raw) {
            const signal = entry.instancePath;
            // value is a JSON-encoded array e.g. "[\"0010\"]" or "[\"1\"]"
            let bits: string;
            try {
                const parsed = JSON.parse(entry.value);
                bits = Array.isArray(parsed) ? String(parsed[0]) : String(parsed);
            } catch {
                bits = entry.value;
            }
            // Convert binary string to hex for readability (e.g. "1101" -> "d")
            const strValue = /^[01]+$/.test(bits) && bits.length > 1
                ? `${bits} (0x${parseInt(bits, 2).toString(16).toUpperCase()})`
                : bits;

            if (lastValues[signal] !== strValue) {
                transitions.push({ time, signal, value: strValue });
                lastValues[signal] = strValue;
            }
        }
    }

    log.appendLine(`[VaporView] collected ${transitions.length} transitions`);
    return transitions;
}

export async function buildWaveformContext(
    tracker: SignalTracker,
    startTime: number,
    endTime: number,
    stepSize: number
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
    }>('waveformViewer.getViewerState', { uri });

    const t0 = state?.altMarkerTime ?? state?.markerTime ?? startTime;
    const t1 = state?.markerTime ?? endTime;
    const resolvedStart = Math.min(t0, t1);
    const resolvedEnd = Math.max(t0, t1);

    tracker.log.appendLine(`[WaveformContext] Time range: ${resolvedStart} – ${resolvedEnd}`);

    const transitions = await collectTransitions(uri, signals, resolvedStart, resolvedEnd, stepSize, tracker.log);
    return { uri, signals, transitions, startTime: resolvedStart, endTime: resolvedEnd };
}
