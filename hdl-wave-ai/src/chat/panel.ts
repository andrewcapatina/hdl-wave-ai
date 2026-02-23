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
import { LLMMessage } from '../providers/llm';
import { buildWaveformContext, SignalTracker, WaveformContext } from '../vaporview/api';
import { collectHdlContextSmart } from '../hdl/collector';

const SYSTEM_PROMPT = `You are an expert hardware verification engineer with deep knowledge of Verilog, SystemVerilog, and digital design.

The first user message contains real waveform signal transition data and HDL source files extracted from the active simulation. You MUST base your analysis exclusively on that data — do not invent signal names, values, or behavior. Do not generate hypothetical examples or placeholder code.

When answering:
- Reference actual signal names and timestamps from the provided data
- Cross-reference signal transitions against the HDL logic
- Identify root causes, not just symptoms
- Suggest concrete fixes or assertions where appropriate
- Format signal names and values in backticks`;


export class ChatPanel {
    private static instance: ChatPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly history: LLMMessage[] = [];
    private readonly tracker: SignalTracker;
    private readonly log: vscode.OutputChannel;
    private waveformContextSent = false;   // only send waveform dump once per session
    private currentAbortController: AbortController | undefined;
    private disposables: vscode.Disposable[] = [];

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

    private async handleMessage(msg: { type: string; text?: string; startTime?: number; endTime?: number }) {
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
        if (msg.type !== 'query' || !msg.text) { return; }

        const config = vscode.workspace.getConfiguration('hdlWaveAi');
        const stepSize = config.get<number>('waveform.sampleStepSize', 1);

        const startTime = msg.startTime ?? 0;
        const endTime = msg.endTime ?? config.get<number>('waveform.defaultEndTime', 10000);

        // Create AbortController now so Stop works during collection, not just LLM streaming
        this.currentAbortController = new AbortController();
        const { signal } = this.currentAbortController;

        // Show stop button immediately while collecting context
        this.panel.webview.postMessage({ type: 'collecting' });

        let userContent = msg.text;

        // Only collect and send waveform + HDL context on the first message of a session
        if (!this.waveformContextSent) {
            let contextBlock = '';

            this.log.appendLine(`[Chat] Building waveform context (t=${startTime}..${endTime}, step=${stepSize})`);
            const waveformCtx: WaveformContext | null = await buildWaveformContext(this.tracker, startTime, endTime, stepSize, signal);
            this.log.appendLine(`[Chat] Waveform context done: ${waveformCtx ? waveformCtx.transitions.length + ' transitions' : 'null'}`);

            if (signal.aborted) {
                this.panel.webview.postMessage({ type: 'stream_end' });
                this.currentAbortController = undefined;
                return;
            }

            if (waveformCtx) {
                contextBlock += formatWaveformContext(waveformCtx, 300);
            }

            this.log.appendLine(`[Chat] Collecting HDL context`);
            const hdlContext = await collectHdlContextSmart(waveformCtx?.signals ?? [], this.log);
            this.log.appendLine(`[Chat] HDL context done: ${hdlContext ? hdlContext.length + ' chars' : 'null'}`);
            if (hdlContext) {
                contextBlock += '\n\n' + hdlContext;
            }

            if (contextBlock) {
                userContent = `${contextBlock}\n\n---\n\n${msg.text}`;
                this.waveformContextSent = true;
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

        const messages: LLMMessage[] = conversational
            ? [{ role: 'system', content: SYSTEM_PROMPT }, ...this.history.slice(-maxHistory)]
            : [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userContent }];

        try {
            const provider = createProvider();
            const { marked } = await import('marked');
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
        } catch (err) {
            if (signal.aborted) {
                // Roll back the user message so the next query starts clean
                this.history.pop();
                if (contextWasJustSent) {
                    this.waveformContextSent = false;
                }
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
</style>
</head>
<body>
<div id="toolbar">
  <button id="refresh">&#8635; Refresh Context</button>
</div>
<div id="messages"></div>
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

  function addMessage(role, content) {
    const div = document.createElement('div');
    div.className = 'message ' + role;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = content;
    div.appendChild(bubble);
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
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
      messagesEl.scrollTop = messagesEl.scrollHeight;
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
      messagesEl.scrollTop = messagesEl.scrollHeight;
      stopEl.style.display = 'block';
    } else if (msg.type === 'chunk') {
      if (streamBubble) {
        if (!hasContent) {
          stopLoadingDots(streamBubble);
          streamBubble.style.whiteSpace = '';
          streamBubble.classList.add('rendered');
          hasContent = true;
        }
        streamBubble.innerHTML = msg.html ?? (streamBubble.innerHTML + msg.text);
        messagesEl.scrollTop = messagesEl.scrollHeight;
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
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  });
</script>
</body>
</html>`;
}
