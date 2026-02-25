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
import { createProvider } from '../providers/factory';
import { LLMMessage, ToolDefinition } from '../providers/llm';
import { buildWaveformContext, getActiveDocumentUri, SignalTracker, WaveformContext } from '../vaporview/api';
import { collectHdlContextSmart } from '../hdl/collector';
import { WaveformIndex } from '../waveform/vcd';
import { parseWaveformFile } from '../waveform/fst';
import hljs from 'highlight.js/lib/core';
import verilog from 'highlight.js/lib/languages/verilog';

// Register languages for syntax highlighting in chat
hljs.registerLanguage('verilog', verilog);
hljs.registerLanguage('systemverilog', verilog);
hljs.registerLanguage('sv', verilog);

/** Lazily initialize marked with highlight.js integration (ESM dynamic imports). */
let _marked: any = null;
async function getMarked(): Promise<{ parse: (src: string) => string }> {
    if (!_marked) {
        const { marked } = await import('marked');
        const { markedHighlight } = await import('marked-highlight');
        marked.use(markedHighlight({
            highlight(code: string, lang: string) {
                if (lang && hljs.getLanguage(lang)) {
                    return hljs.highlight(code, { language: lang }).value;
                }
                return hljs.highlight(code, { language: 'verilog' }).value;
            },
        }));
        _marked = marked;
    }
    return _marked;
}

const SYSTEM_PROMPT = `You are an expert hardware verification engineer with deep knowledge of Verilog, SystemVerilog, and digital design.

The first user message contains real waveform signal transition data and HDL source files extracted from the active simulation. You MUST base your analysis exclusively on that data — do not invent signal names, values, or behavior. Do not generate hypothetical examples or placeholder code.

When answering:
- Reference actual signal names and timestamps from the provided data
- Cross-reference signal transitions against the HDL logic
- Identify root causes, not just symptoms
- Suggest concrete fixes or assertions where appropriate
- Format signal names and values in backticks`;

const TOOL_SYSTEM_PROMPT = `You are an expert hardware verification engineer analyzing waveform simulations alongside RTL source code.

You have access to tools to query a waveform database. The list_signals result has already been provided — do NOT call list_signals again.

TOOL USAGE:
- When the user specifies a time range, use those EXACT values as t_start and t_end. Never substitute your own.
- Use query_transitions() to see how signals change over time in the range.
- Use get_value_at() to sample multiple signals at the same timestamp for a snapshot of circuit state.

ANALYSIS METHODOLOGY:
1. Identify key timestamps where significant state changes occur (e.g. address jumps, bus transactions, control signal edges).
2. For each key event, sample related signals at that timestamp to build a complete picture.
3. Cross-reference observed values against the RTL source — quote the specific Verilog line that explains the behavior.
4. Decode data values in context: instruction bus values are opcodes, address bus values are memory regions, control signals drive state machines.
5. Build a narrative of what the circuit is doing over time, not just a list of values.

CITATION REQUIREMENT:
When referencing RTL behavior, quote the actual Verilog code from the provided HDL source. For example:
  "The bridge forwards the request because \`assign XDREQ = HIT ? 0 : DDREQ;\` in darkbridge shows that on a cache miss (HIT=0), DDREQ passes through."
Do NOT paraphrase or invent Verilog code. Only quote lines that appear in the provided HDL source.

Do not invent signal names, values, or behavior. Only report conclusions backed by data from tools.`;

const WAVEFORM_TOOLS: ToolDefinition[] = [
    {
        name: 'list_signals',
        description: 'List all signals in the waveform with their transition counts. Call this first to understand what signals are available and how active they are.',
        parameters: { type: 'object', properties: {}, required: [] },
    },
    {
        name: 'query_transitions',
        description: 'Get transitions for a specific signal within a time range. Returns timestamp and value for each change. Capped at 150 — narrow the range if truncated. IMPORTANT: use the exact t_start and t_end from the user query.',
        parameters: {
            type: 'object',
            properties: {
                signal: { type: 'string', description: 'Full signal name as returned by list_signals' },
                t_start: { type: 'number', description: 'Start timestamp (inclusive). Use the value from the user query.' },
                t_end: { type: 'number', description: 'End timestamp (inclusive). Use the value from the user query.' },
            },
            required: ['signal', 't_start', 't_end'],
        },
    },
    {
        name: 'get_value_at',
        description: 'Get the last known value of a signal at or before a specific timestamp.',
        parameters: {
            type: 'object',
            properties: {
                signal: { type: 'string', description: 'Full signal name' },
                time: { type: 'number', description: 'Timestamp to query' },
            },
            required: ['signal', 'time'],
        },
    },
];


export class ChatPanel {
    private static instance: ChatPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly history: LLMMessage[] = [];
    private readonly tracker: SignalTracker;
    private readonly log: vscode.OutputChannel;
    private waveformContextSent = false;   // only send waveform dump once per session (non-tool mode)
    private currentAbortController: AbortController | undefined;
    private disposables: vscode.Disposable[] = [];
    /** Pre-parsed context from a file (FST/VCD). When set, VaporView is bypassed. */
    private preloadedContext: WaveformContext | undefined;
    /** In-memory index for tool-use (RAG) mode. Built lazily on first query. */
    private waveformIndex: WaveformIndex | undefined;
    /** Signals selected in the picker. undefined = not yet initialised (use all). */
    private selectedSignals: string[] | undefined = undefined;

    private constructor(panel: vscode.WebviewPanel, tracker: SignalTracker, log: vscode.OutputChannel) {
        this.panel = panel;
        this.tracker = tracker;
        this.log = log;
        this.panel.webview.html = getWebviewHtml();

        this.panel.webview.onDidReceiveMessage(
            msg => {
                this.log.appendLine(`[Chat] Received message from webview: ${JSON.stringify(msg)}`);
                this.handleMessage(msg);
            },
            null,
            this.disposables
        );

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    }

    static createOrShow(tracker: SignalTracker, log: vscode.OutputChannel): ChatPanel {
        if (ChatPanel.instance) {
            ChatPanel.instance.panel.reveal(vscode.ViewColumn.Beside);
            return ChatPanel.instance;
        }

        const panel = vscode.window.createWebviewPanel(
            'hdlWaveAiChat',
            'HDL Wave AI',
            vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        ChatPanel.instance = new ChatPanel(panel, tracker, log);
        return ChatPanel.instance;
    }

    /**
     * Open a new chat pre-loaded with a parsed waveform file context.
     * Any existing panel is disposed first so the file context starts fresh.
     */
    static createWithFile(ctx: WaveformContext, title: string, tracker: SignalTracker, log: vscode.OutputChannel): ChatPanel {
        if (ChatPanel.instance) {
            ChatPanel.instance.panel.dispose();
            ChatPanel.instance = undefined;
        }

        const panel = vscode.window.createWebviewPanel(
            'hdlWaveAiChat',
            `HDL Wave AI — ${title}`,
            vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        const instance = new ChatPanel(panel, tracker, log);
        instance.preloadedContext = ctx;
        instance.waveformIndex = new WaveformIndex(ctx);
        ChatPanel.instance = instance;
        return instance;
    }

    /** Called when VaporView signals change — updates the picker in the open panel. */
    static notifySignalsChanged(signals: string[]): void {
        if (!ChatPanel.instance) { return; }
        ChatPanel.instance.panel.webview.postMessage({ type: 'signals_update', signals });
    }

    /**
     * Called from extension.ts when VaporView fires onDidSetMarker.
     * Shows a clickable prompt suggestion in the chat if the panel is open.
     */
    static notifyMarkerSet(markerTime: number | null, altMarkerTime: number | null): void {
        if (!ChatPanel.instance) { return; }

        let display: string;
        let query: string;

        if (markerTime !== null && altMarkerTime !== null) {
            const t0 = Math.min(markerTime, altMarkerTime);
            const t1 = Math.max(markerTime, altMarkerTime);
            display = `Analyze t=${t0} \u2013 t=${t1}`;
            query = `Analyze all signal transitions between t=${t0} and t=${t1}. What events occur in this time window and what is the circuit doing?`;
        } else if (markerTime !== null) {
            display = `Analyze at t=${markerTime}`;
            query = `What is the state of all signals at t=${markerTime}? Describe what the circuit is doing at this point.`;
        } else if (altMarkerTime !== null) {
            display = `Analyze at t=${altMarkerTime}`;
            query = `What is the state of all signals at t=${altMarkerTime}? Describe what the circuit is doing at this point.`;
        } else {
            // Both markers cleared — dismiss any pending suggestion
            ChatPanel.instance.panel.webview.postMessage({ type: 'clear_suggestions' });
            return;
        }

        ChatPanel.instance.panel.webview.postMessage({ type: 'marker_suggestion', display, query });
    }

    private async handleMessage(msg: { type: string; text?: string; startTime?: number; endTime?: number }): Promise<void> {
        if (msg.type === 'stop') {
            this.currentAbortController?.abort();
            return;
        }
        if (msg.type === 'refresh') {
            this.waveformContextSent = false;
            this.history.splice(0);
            this.panel.webview.postMessage({ type: 'context_reset' });
            return;
        }
        if (msg.type === 'ready') {
            // Webview just loaded — send current signal list to populate the picker
            let signals: string[] = [];
            if (this.preloadedContext) {
                signals = this.preloadedContext.signals;
            } else {
                const activeUri = await getActiveDocumentUri(this.log);
                if (activeUri) { signals = this.tracker.getSignals(activeUri); }
            }
            this.panel.webview.postMessage({ type: 'signals_update', signals });
            return;
        }
        if (msg.type === 'signals_selected') {
            this.selectedSignals = (msg as { type: string; signals?: string[] }).signals ?? [];
            return;
        }
        // Sent by a suggestion chip click: refresh context then run the query
        if (msg.type === 'marker_query' && msg.text) {
            this.waveformContextSent = false;
            this.history.splice(0);
            // Re-dispatch as a normal query so the full collection + LLM path runs
            return this.handleMessage({ type: 'query', text: msg.text });
        }
        if (msg.type !== 'query' || !msg.text) { return; }

        const config = vscode.workspace.getConfiguration('hdlWaveAi');
        const stepSize = config.get<number>('waveform.sampleStepSize', 1);
        const useToolMode = config.get<boolean>('waveform.useToolMode', true);

        const startTime = msg.startTime ?? 0;
        const endTime = msg.endTime ?? config.get<number>('waveform.defaultEndTime', 10000);

        // Create AbortController now so Stop works during collection, not just LLM streaming
        this.currentAbortController = new AbortController();
        const { signal } = this.currentAbortController;

        // Show stop button immediately while collecting context
        this.panel.webview.postMessage({ type: 'collecting' });

        let userContent = msg.text;
        const provider = createProvider();
        const canUseTools = useToolMode && !!provider.chatWithTools;

        // ── Build waveform index (tool mode) or context block (legacy mode) ──
        if (!this.waveformContextSent) {
            let rawCtx: WaveformContext | null = null;

            if (this.preloadedContext) {
                // File mode: index already built in createWithFile
                this.log.appendLine(`[Chat] Using preloaded file context (${this.preloadedContext.transitions.length} transitions)`);
                rawCtx = this.preloadedContext;
            } else {
                // VaporView mode: poll signals
                this.log.appendLine(`[Chat] Building waveform context (t=${startTime}..${endTime}, step=${stepSize})`);
                rawCtx = await buildWaveformContext(this.tracker, startTime, endTime, stepSize, signal);
                this.log.appendLine(`[Chat] Waveform context: ${rawCtx ? rawCtx.transitions.length + ' transitions' : 'null'}`);

                if (signal.aborted) {
                    this.panel.webview.postMessage({ type: 'stream_end' });
                    this.currentAbortController = undefined;
                    return;
                }

                // For tool mode: parse the FULL waveform file so the LLM can
                // query any time range, not just the marker-filtered subset.
                // Also handles the case where the tracker has no signals yet
                // (rawCtx is null) — we get the URI from VaporView directly.
                if (canUseTools && !this.waveformIndex) {
                    const fileUri = rawCtx?.uri ?? await getActiveDocumentUri(this.log);
                    if (fileUri) {
                        try {
                            const filePath = vscode.Uri.parse(fileUri).fsPath;
                            this.log.appendLine(`[Chat] Parsing full file for tool index: ${filePath}`);
                            const fullParse = await parseWaveformFile(filePath);
                            this.waveformIndex = new WaveformIndex({
                                ...fullParse,
                                uri: fileUri,
                                startTime: 0,
                            });
                            this.log.appendLine(`[Chat] WaveformIndex built from full file: ${this.waveformIndex.signals.length} signals, ${fullParse.transitions.length} transitions`);
                        } catch (err) {
                            this.log.appendLine(`[Chat] Full file parse failed: ${err}`);
                            if (rawCtx) {
                                this.waveformIndex = new WaveformIndex(rawCtx);
                            }
                        }
                    }
                }
            }

            if (canUseTools && this.waveformIndex) {
                // Tool mode ready — context will be injected in the tool loop below
                this.waveformContextSent = true;
            } else {
                // ── Legacy mode (or fallback when tool index failed) ──────────
                let finalCtx = rawCtx;
                if (finalCtx && this.selectedSignals !== undefined && this.selectedSignals.length > 0) {
                    const selSet = new Set(this.selectedSignals);
                    finalCtx = {
                        ...finalCtx,
                        signals: finalCtx.signals.filter(s => selSet.has(s)),
                        transitions: finalCtx.transitions.filter(t => selSet.has(t.signal)),
                    };
                    this.log.appendLine(`[Chat] Signal filter applied: ${finalCtx.signals.length}/${rawCtx!.signals.length} signals`);
                }

                let contextBlock = '';
                if (finalCtx) { contextBlock += formatWaveformContext(finalCtx, 300); }

                this.log.appendLine(`[Chat] Collecting HDL context`);
                const hdlContext = await collectHdlContextSmart(finalCtx?.signals ?? [], this.log);
                if (hdlContext) { contextBlock += '\n\n' + hdlContext; }

                if (contextBlock) {
                    userContent = `${contextBlock}\n\n---\n\n${msg.text}`;
                    this.waveformContextSent = true;
                }
            }
        }

        if (signal.aborted) {
            this.panel.webview.postMessage({ type: 'stream_end' });
            this.currentAbortController = undefined;
            return;
        }

        const contextWasJustSent = this.waveformContextSent && userContent !== msg.text;
        this.history.push({ role: 'user', content: userContent });

        const config2 = vscode.workspace.getConfiguration('hdlWaveAi');
        const conversational = config2.get<boolean>('chat.conversational', true);
        const maxHistory = config2.get<number>('chat.maxHistory', 20);

        try {
            const marked = await getMarked();

            if (canUseTools && this.waveformIndex) {
                // ── Tool mode: compact summary + tool loop ────────────────────
                const idx = this.waveformIndex;
                const selSet = this.selectedSignals !== undefined && this.selectedSignals.length > 0
                    ? new Set(this.selectedSignals) : null;

                const summary = buildWaveformSummary(idx, selSet);
                const hdlContext = await collectHdlContextSmart(
                    selSet ? idx.signals.filter(s => selSet.has(s)) : idx.signals,
                    this.log
                );
                // Extract the user's time range — prefer explicit values in text,
                // fall back to VaporView marker positions, then webview msg values.
                let timeRange = extractTimeRange(msg.text);
                if (!timeRange) {
                    // Query VaporView for current marker positions
                    try {
                        const viewerState = await vscode.commands.executeCommand<{
                            markerTime: number | null;
                            altMarkerTime: number | null;
                        }>('waveformViewer.getViewerState', { uri: idx.uri });
                        if (viewerState?.markerTime !== null && viewerState?.markerTime !== undefined
                            && viewerState?.altMarkerTime !== null && viewerState?.altMarkerTime !== undefined) {
                            timeRange = {
                                tStart: Math.min(viewerState.markerTime, viewerState.altMarkerTime),
                                tEnd: Math.max(viewerState.markerTime, viewerState.altMarkerTime),
                            };
                        }
                    } catch { /* VaporView not available */ }
                }
                if (!timeRange && msg.startTime !== undefined && msg.endTime !== undefined) {
                    timeRange = { tStart: msg.startTime, tEnd: msg.endTime };
                }
                const rangeHint = timeRange
                    ? `\n\n## Query Time Range\nThe user is asking about t_start=${timeRange.tStart} to t_end=${timeRange.tEnd}. You MUST use these exact values in query_transitions calls.`
                    : '';
                if (timeRange) {
                    this.log.appendLine(`[Chat] Time range for query: ${timeRange.tStart} – ${timeRange.tEnd}`);
                }

                const contextPrefix = summary + rangeHint + (hdlContext ? '\n\n' + hdlContext : '');
                const fullUserContent = `${contextPrefix}\n\n---\n\n${msg.text}`;

                // Use full history in conversational mode, but prefix context each time
                const messages: LLMMessage[] = conversational
                    ? [{ role: 'system', content: TOOL_SYSTEM_PROMPT }, ...this.history.slice(-(maxHistory - 1)), { role: 'user', content: fullUserContent }]
                    : [{ role: 'system', content: TOOL_SYSTEM_PROMPT }, { role: 'user', content: fullUserContent }];

                // Replace the history entry (userContent may differ from fullUserContent)
                this.history[this.history.length - 1] = { role: 'user', content: fullUserContent };

                const executor = buildToolExecutor(idx, selSet, this.log);

                this.log.appendLine(`[Chat] Tool mode: running tool loop`);
                this.panel.webview.postMessage({ type: 'stream_start' });

                let streamedText = '';
                const finalText = await provider.chatWithTools!(messages, WAVEFORM_TOOLS, executor, signal, (event) => {
                    if (event.type === 'tool_call') {
                        this.log.appendLine(`[Chat] Tool call: ${event.name}(${JSON.stringify(event.args)})`);
                    } else if (event.type === 'chunk') {
                        streamedText += event.text;
                        const html = marked.parse(streamedText) as string;
                        this.panel.webview.postMessage({ type: 'chunk', text: event.text, html });
                    }
                }, hdlContext ?? undefined);

                if (!streamedText && finalText) {
                    // Non-streamed response (model replied directly without retry)
                    const html = marked.parse(finalText) as string;
                    this.panel.webview.postMessage({ type: 'chunk', text: finalText, html });
                }
                if (finalText) {
                    this.history.push({ role: 'assistant', content: finalText });
                }
                this.panel.webview.postMessage({ type: 'stream_end' });

            } else {
                // ── Legacy streaming mode ─────────────────────────────────────
                const messages: LLMMessage[] = conversational
                    ? [{ role: 'system', content: SYSTEM_PROMPT }, ...this.history.slice(-maxHistory)]
                    : [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userContent }];

                this.log.appendLine(`[Chat] Sending ${messages.length} messages to LLM (streaming)`);
                this.panel.webview.postMessage({ type: 'stream_start' });
                let fullResponse = '';
                for await (const chunk of provider.stream(messages, signal)) {
                    fullResponse += chunk;
                    const html = marked.parse(fullResponse) as string;
                    this.panel.webview.postMessage({ type: 'chunk', text: chunk, html });
                }
                if (fullResponse) {
                    this.history.push({ role: 'assistant', content: fullResponse });
                }
                this.panel.webview.postMessage({ type: 'stream_end' });
            }
        } catch (err) {
            if (signal.aborted) {
                this.history.pop();
                if (contextWasJustSent) { this.waveformContextSent = false; }
                this.panel.webview.postMessage({ type: 'stream_end' });
            } else {
                const errMsg = err instanceof Error ? err.message : String(err);
                this.log.appendLine(`[Chat] Error: ${errMsg}`);
                this.panel.webview.postMessage({ type: 'error', text: errMsg });
            }
        } finally {
            this.currentAbortController = undefined;
        }
    }

    private dispose() {
        ChatPanel.instance = undefined;
        this.panel.dispose();
        for (const d of this.disposables) { d.dispose(); }
        this.disposables = [];
    }
}

function buildWaveformSummary(idx: WaveformIndex, selSet: Set<string> | null): string {
    const allSignals = idx.listSignals();
    const signals = selSet ? allSignals.filter(s => selSet.has(s.name)) : allSignals;
    const top = [...signals].sort((a, b) => b.transitionCount - a.transitionCount).slice(0, 30);

    const lines = [
        `## Waveform Summary (tool-query mode)`,
        `File: ${idx.uri}`,
        `Time range: ${idx.startTime} \u2013 ${idx.endTime} (timescale: ${idx.timescale})`,
        `Signals available: ${signals.length} — use list_signals() for full list, query_transitions() to fetch data`,
        ``,
        `Top signals by activity:`,
        ...top.map(s => `  ${s.name}: ${s.transitionCount} transitions`),
        ...(signals.length > 30 ? [`  \u2026 and ${signals.length - 30} more`] : []),
    ];
    return lines.join('\n');
}

function buildToolExecutor(
    idx: WaveformIndex,
    selSet: Set<string> | null,
    log: vscode.OutputChannel
): (name: string, args: Record<string, unknown>) => string {
    const TRANSITION_CAP = 150;
    return (name: string, args: Record<string, unknown>): string => {
        log.appendLine(`[Chat] Tool call: ${name}(${JSON.stringify(args)})`);
        switch (name) {
            case 'list_signals': {
                const all = idx.listSignals();
                const signals = selSet ? all.filter(s => selSet.has(s.name)) : all;
                return JSON.stringify(signals);
            }
            case 'query_transitions': {
                const sig = String(args['signal'] ?? '');
                const tStart = Number(args['t_start'] ?? 0);
                const tEnd = Number(args['t_end'] ?? idx.endTime);
                const result = idx.queryTransitions(sig, tStart, tEnd, TRANSITION_CAP);
                if (result.length === 0) {
                    return `No transitions found for "${sig}" in [${tStart}, ${tEnd}].`;
                }
                const truncNote = result.length >= TRANSITION_CAP
                    ? `[Truncated at ${TRANSITION_CAP}. Narrow the range for more detail.]\n` : '';
                return truncNote + result.map(t => `t=${t.time}: ${t.value}`).join('\n');
            }
            case 'get_value_at': {
                const sig = String(args['signal'] ?? '');
                const time = Number(args['time'] ?? 0);
                return `"${sig}" at t=${time}: ${idx.getValueAt(sig, time)}`;
            }
            default:
                return `Unknown tool: ${name}`;
        }
    };
}

function extractTimeRange(text: string): { tStart: number; tEnd: number } | null {
    const match = text.match(/t\s*=\s*(\d+)[\s\S]*?t\s*=\s*(\d+)/i);
    if (match) {
        return { tStart: Number(match[1]), tEnd: Number(match[2]) };
    }
    return null;
}

function formatWaveformContext(ctx: WaveformContext, maxTransitions: number): string {
    const config = vscode.workspace.getConfiguration('hdlWaveAi');
    const cap = config.get<number>('waveform.maxTransitions', maxTransitions);

    let transitions = ctx.transitions;
    let truncated = false;
    if (transitions.length > cap) {
        // Evenly sample across the full time range to preserve temporal spread
        const step = transitions.length / cap;
        transitions = Array.from({ length: cap }, (_, i) => transitions[Math.round(i * step)]);
        truncated = true;
    }

    const lines = [
        `## Waveform Context`,
        `File: ${ctx.uri}`,
        `Time range: ${ctx.startTime} – ${ctx.endTime}`,
        `Signals (${ctx.signals.length}): ${ctx.signals.join(', ')}`,
        `Transitions: ${transitions.length}${truncated ? ` (evenly sampled from ${ctx.transitions.length})` : ''}`,
        ``,
        `### Signal Transitions`,
        `time | signal | value`,
        `-----|--------|------`,
    ];

    for (const t of transitions) {
        lines.push(`${t.time} | ${t.signal} | ${t.value}`);
    }

    return lines.join('\n');
}


function getWebviewHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>HDL Wave AI</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  #messages {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .message { display: flex; flex-direction: column; }
  .message.user { align-items: flex-end; }
  .message.assistant { align-items: flex-start; }
  .bubble {
    padding: 8px 12px;
    border-radius: 6px;
    max-width: 85%;
    line-height: 1.5;
  }
  .message.user .bubble {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    white-space: pre-wrap;
  }
  .message.assistant .bubble {
    background: var(--vscode-editor-inactiveSelectionBackground);
    white-space: pre-wrap;
  }
  .message.assistant .bubble.rendered { white-space: normal; }
  .message.error .bubble {
    background: var(--vscode-inputValidation-errorBackground);
    color: var(--vscode-inputValidation-errorForeground);
  }
  /* Markdown styles inside assistant bubbles */
  .message.assistant .bubble p { margin: 4px 0; }
  .message.assistant .bubble p:first-child { margin-top: 0; }
  .message.assistant .bubble p:last-child { margin-bottom: 0; }
  .message.assistant .bubble h1,
  .message.assistant .bubble h2,
  .message.assistant .bubble h3 { margin: 10px 0 4px; font-weight: bold; }
  .message.assistant .bubble h1 { font-size: 1.2em; }
  .message.assistant .bubble h2 { font-size: 1.1em; }
  .message.assistant .bubble h3 { font-size: 1.0em; }
  .message.assistant .bubble ul,
  .message.assistant .bubble ol { padding-left: 20px; margin: 4px 0; }
  .message.assistant .bubble li { margin: 2px 0; }
  .message.assistant .bubble code {
    background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.2));
    padding: 1px 4px;
    border-radius: 3px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
  }
  .message.assistant .bubble pre {
    background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.2));
    padding: 10px 12px;
    border-radius: 4px;
    overflow-x: auto;
    margin: 6px 0;
  }
  .message.assistant .bubble pre code {
    background: none;
    padding: 0;
    font-size: inherit;
  }
  /* highlight.js — VS Code Dark+ colors */
  .hljs { color: #d4d4d4; }
  .hljs-keyword, .hljs-tag { color: #569cd6; }
  .hljs-built_in, .hljs-type { color: #4ec9b0; }
  .hljs-literal { color: #569cd6; }
  .hljs-number { color: #b5cea8; }
  .hljs-string { color: #ce9178; }
  .hljs-comment, .hljs-quote { color: #6a9955; font-style: italic; }
  .hljs-variable, .hljs-params, .hljs-attr { color: #9cdcfe; }
  .hljs-title, .hljs-title.function_ { color: #dcdcaa; }
  .hljs-symbol { color: #b5cea8; }
  .hljs-meta { color: #569cd6; }
  .hljs-regexp { color: #d16969; }
  .hljs-section, .hljs-name { color: #569cd6; }
  .hljs-selector-class, .hljs-selector-id { color: #d7ba7d; }
  .message.assistant .bubble table {
    border-collapse: collapse;
    margin: 6px 0;
    font-size: 0.9em;
  }
  .message.assistant .bubble th,
  .message.assistant .bubble td {
    border: 1px solid var(--vscode-panel-border);
    padding: 4px 8px;
  }
  .message.assistant .bubble th { font-weight: bold; }
  .message.assistant .bubble blockquote {
    border-left: 3px solid var(--vscode-panel-border);
    padding-left: 10px;
    margin: 4px 0;
    color: var(--vscode-descriptionForeground);
  }
  #input-area {
    display: flex;
    gap: 8px;
    padding: 12px;
    border-top: 1px solid var(--vscode-panel-border);
  }
  #input {
    flex: 1;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    padding: 6px 8px;
    resize: none;
    font-family: inherit;
    font-size: inherit;
  }
  #toolbar {
    display: flex;
    justify-content: flex-end;
    padding: 4px 12px 0;
  }
  #refresh {
    background: none;
    color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-panel-border);
    padding: 3px 10px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.85em;
    border-radius: 3px;
  }
  #refresh:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
  #send, #stop {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 6px 14px;
    cursor: pointer;
    font-family: inherit;
  }
  #send:hover, #stop:hover { background: var(--vscode-button-hoverBackground); }
  #send:disabled { opacity: 0.5; cursor: default; }
  #stop { background: var(--vscode-errorForeground); display: none; }
  .message.status .bubble {
    background: none;
    color: var(--vscode-descriptionForeground);
    font-style: italic;
    font-size: 0.85em;
    padding: 2px 0;
  }
  /* ── Signal picker ──────────────────────────────────────────────── */
  #signal-picker { border-bottom: 1px solid var(--vscode-panel-border); font-size: 0.85em; }
  #signal-picker-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 5px 12px; cursor: pointer; user-select: none;
    color: var(--vscode-descriptionForeground);
  }
  #signal-picker-header:hover { background: var(--vscode-toolbar-hoverBackground); }
  #signal-picker-toggle { display: flex; align-items: center; gap: 5px; }
  #signal-picker-ctrls { display: flex; gap: 8px; }
  .sp-btn {
    background: none; border: none; padding: 0;
    color: var(--vscode-textLink-foreground);
    cursor: pointer; font-size: inherit;
  }
  .sp-btn:hover { text-decoration: underline; }
  #signal-picker-list {
    padding: 4px 12px 8px; display: flex; flex-direction: column;
    gap: 3px; max-height: 150px; overflow-y: auto;
  }
  #signal-picker-list.hidden { display: none; }
  .signal-item { display: flex; align-items: center; gap: 7px; cursor: pointer; }
  .signal-item input[type=checkbox] { cursor: pointer; flex-shrink: 0; }
  .signal-item label {
    cursor: pointer; font-family: var(--vscode-editor-font-family, monospace);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  #signal-picker-empty {
    color: var(--vscode-descriptionForeground); font-style: italic; padding: 2px 0;
  }
  /* ── Suggestions ──────────────────────────────────────────────── */
  #suggestions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 0 12px 6px;
    min-height: 0;
  }
  #suggestions:empty { display: none; }
  .suggestion-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.15));
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
    border-radius: 12px;
    padding: 3px 10px 3px 12px;
    font-size: 0.85em;
    cursor: pointer;
    transition: opacity 0.1s;
  }
  .suggestion-chip:hover { opacity: 0.85; }
  .suggestion-chip .chip-label::before { content: '\\26A1\\FE0E\\00A0'; }
  .suggestion-chip .chip-dismiss {
    opacity: 0.5;
    font-size: 1.1em;
    line-height: 1;
    padding: 0 2px;
  }
  .suggestion-chip .chip-dismiss:hover { opacity: 1; }
</style>
</head>
<body>
<div id="toolbar">
  <button id="refresh">&#8635; Refresh Context</button>
</div>
<div id="signal-picker">
  <div id="signal-picker-header">
    <span id="signal-picker-toggle">&#9654; Signals</span>
    <span id="signal-picker-ctrls" style="display:none">
      <button class="sp-btn" id="sp-all">All</button>
      <button class="sp-btn" id="sp-none">None</button>
    </span>
  </div>
  <div id="signal-picker-list" class="hidden">
    <div id="signal-picker-empty">Add signals in VaporView to see them here.</div>
  </div>
</div>
<div id="messages"></div>
<div id="suggestions"></div>
<div id="input-area">
  <textarea id="input" rows="3" placeholder="Ask about your waveform or HDL design... (Shift+Enter for newline)"></textarea>
  <button id="send">Send</button>
  <button id="stop">Stop</button>
</div>
<script>
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const sendEl = document.getElementById('send');
  const stopEl = document.getElementById('stop');
  const refreshEl = document.getElementById('refresh');
  const suggestionsEl = document.getElementById('suggestions');

  // ── Signal picker ────────────────────────────────────────────────────────
  const pickerHeader  = document.getElementById('signal-picker-header');
  const pickerToggle  = document.getElementById('signal-picker-toggle');
  const pickerList    = document.getElementById('signal-picker-list');
  const pickerCtrls   = document.getElementById('signal-picker-ctrls');
  const spAllBtn      = document.getElementById('sp-all');
  const spNoneBtn     = document.getElementById('sp-none');

  let pickerOpen = false;
  let availableSignals = [];
  let selectedSignals  = new Set();

  function updatePickerHeader() {
    const total    = availableSignals.length;
    const sel      = selectedSignals.size;
    const arrow    = pickerOpen ? '\u25BE' : '\u25B8';
    const countStr = total === 0 ? '' : sel === total ? ' (' + total + ')' : ' (' + sel + '/' + total + ')';
    pickerToggle.textContent = arrow + ' Signals' + countStr;
    pickerCtrls.style.display = (pickerOpen && total > 0) ? 'flex' : 'none';
  }

  function renderSignalList() {
    pickerList.innerHTML = '';
    if (availableSignals.length === 0) {
      const msg = document.createElement('div');
      msg.id = 'signal-picker-empty';
      msg.textContent = 'Add signals in VaporView to see them here.';
      pickerList.appendChild(msg);
      return;
    }
    for (const sig of availableSignals) {
      const item = document.createElement('div');
      item.className = 'signal-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = 'spck-' + sig;
      cb.checked = selectedSignals.has(sig);
      cb.addEventListener('change', () => {
        if (cb.checked) { selectedSignals.add(sig); } else { selectedSignals.delete(sig); }
        updatePickerHeader();
        postSignalSelection();
      });
      const lbl = document.createElement('label');
      lbl.htmlFor = 'spck-' + sig;
      lbl.textContent = sig;
      item.appendChild(cb);
      item.appendChild(lbl);
      pickerList.appendChild(item);
    }
  }

  function postSignalSelection() {
    if (availableSignals.length > 0) {
      vscode.postMessage({ type: 'signals_selected', signals: Array.from(selectedSignals) });
    }
  }

  pickerHeader.addEventListener('click', () => {
    pickerOpen = !pickerOpen;
    pickerList.className = pickerOpen ? '' : 'hidden';
    updatePickerHeader();
  });

  spAllBtn.addEventListener('click', e => {
    e.stopPropagation();
    for (const s of availableSignals) { selectedSignals.add(s); }
    renderSignalList(); updatePickerHeader(); postSignalSelection();
  });

  spNoneBtn.addEventListener('click', e => {
    e.stopPropagation();
    selectedSignals.clear();
    renderSignalList(); updatePickerHeader(); postSignalSelection();
  });

  function applySignalsUpdate(signals) {
    const prevAvailable = new Set(availableSignals);
    availableSignals = signals;
    // New signals default to selected; signals removed from VaporView are dropped
    for (const s of signals)  { if (!prevAvailable.has(s)) { selectedSignals.add(s); } }
    for (const s of selectedSignals) { if (!signals.includes(s)) { selectedSignals.delete(s); } }
    renderSignalList();
    updatePickerHeader();
    postSignalSelection();
  }

  // ── Suggestion chips ─────────────────────────────────────────────────────
  function showSuggestionChip(display, query) {
    suggestionsEl.innerHTML = ''; // only one chip at a time
    const chip = document.createElement('div');
    chip.className = 'suggestion-chip';

    const label = document.createElement('span');
    label.className = 'chip-label';
    label.textContent = display;

    const dismiss = document.createElement('span');
    dismiss.className = 'chip-dismiss';
    dismiss.textContent = '\u00d7';
    dismiss.title = 'Dismiss';
    dismiss.addEventListener('click', e => {
      e.stopPropagation();
      chip.remove();
    });

    chip.appendChild(label);
    chip.appendChild(dismiss);
    chip.addEventListener('click', () => {
      suggestionsEl.innerHTML = '';
      addMessage('user', query);
      sendEl.disabled = true;
      vscode.postMessage({ type: 'marker_query', text: query });
    });

    suggestionsEl.appendChild(chip);
  }

  function addMessage(role, content) {
    const div = document.createElement('div');
    div.className = 'message ' + role;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = content;
    div.appendChild(bubble);
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  function send() {
    const text = inputEl.value.trim();
    if (!text || sendEl.disabled) { return; }
    addMessage('user', text);
    inputEl.value = '';
    sendEl.disabled = true;
    console.log('[HDL Wave AI] Posting message:', text);
    vscode.postMessage({ type: 'query', text });
  }

  sendEl.addEventListener('click', send);
  stopEl.addEventListener('click', () => {
    vscode.postMessage({ type: 'stop' });
  });

  refreshEl.addEventListener('click', () => {
    vscode.postMessage({ type: 'refresh' });
  });

  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  let streamBubble = null;
  let loadingInterval = null;
  let hasContent = false;

  /** Returns true if the user is scrolled near the bottom (within 80px). */
  function isNearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function startLoadingDots(bubble) {
    const states = ['\u25cf', '\u25cf \u25cf', '\u25cf \u25cf \u25cf'];
    let i = 0;
    bubble.textContent = states[0];
    bubble.style.opacity = '0.6';
    loadingInterval = setInterval(() => {
      i = (i + 1) % states.length;
      bubble.textContent = states[i];
    }, 400);
  }

  function stopLoadingDots(bubble) {
    if (loadingInterval) {
      clearInterval(loadingInterval);
      loadingInterval = null;
    }
    bubble.style.opacity = '';
  }

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type === 'collecting') {
      // Show stop button and a status bubble immediately while collecting context
      const div = document.createElement('div');
      div.className = 'message assistant';
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      div.appendChild(bubble);
      messagesEl.appendChild(div);
      streamBubble = bubble;
      hasContent = false;
      bubble.textContent = 'Collecting waveform context\u2026';
      bubble.style.opacity = '0.6';
      scrollToBottom();
      stopEl.style.display = 'block';
    } else if (msg.type === 'stream_start') {
      // Transition the existing bubble (from collecting) into streaming mode
      if (!streamBubble) {
        const div = document.createElement('div');
        div.className = 'message assistant';
        const bubble = document.createElement('div');
        bubble.className = 'bubble';
        div.appendChild(bubble);
        messagesEl.appendChild(div);
        streamBubble = bubble;
      }
      streamBubble.style.opacity = '';
      streamBubble.textContent = '';
      hasContent = false;
      startLoadingDots(streamBubble);
      scrollToBottom();
      stopEl.style.display = 'block';
    } else if (msg.type === 'chunk') {
      if (streamBubble) {
        if (!hasContent) {
          stopLoadingDots(streamBubble);
          streamBubble.style.whiteSpace = '';
          streamBubble.classList.add('rendered');
          hasContent = true;
        }
        const wasAtBottom = isNearBottom();
        streamBubble.innerHTML = msg.html ?? (streamBubble.innerHTML + msg.text);
        if (wasAtBottom) { scrollToBottom(); }
      }
    } else if (msg.type === 'stream_end') {
      if (streamBubble) { stopLoadingDots(streamBubble); }
      streamBubble = null;
      hasContent = false;
      sendEl.disabled = false;
      stopEl.style.display = 'none';
    } else if (msg.type === 'error') {
      if (streamBubble) { stopLoadingDots(streamBubble); }
      streamBubble = null;
      hasContent = false;
      addMessage('error', 'Error: ' + msg.text);
      sendEl.disabled = false;
      stopEl.style.display = 'none';
    } else if (msg.type === 'context_reset') {
      const div = document.createElement('div');
      div.className = 'message status';
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = '\u21bb Context refreshed \u2014 next message will re-collect waveform and HDL data.';
      div.appendChild(bubble);
      messagesEl.appendChild(div);
      scrollToBottom();
    } else if (msg.type === 'marker_suggestion') {
      showSuggestionChip(msg.display, msg.query);
    } else if (msg.type === 'clear_suggestions') {
      suggestionsEl.innerHTML = '';
    } else if (msg.type === 'signals_update') {
      applySignalsUpdate(msg.signals ?? []);
    }
  });

  // Tell the extension the webview is ready so it can send initial signals
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
