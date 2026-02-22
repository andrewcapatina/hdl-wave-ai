import * as vscode from 'vscode';
import { createProvider } from '../providers/factory';
import { LLMMessage } from '../providers/llm';
import { buildWaveformContext, SignalTracker, WaveformContext } from '../vaporview/api';

const SYSTEM_PROMPT = `You are an expert hardware verification engineer with deep knowledge of Verilog, SystemVerilog, and digital design.

You have access to:
1. HDL source files from the current workspace
2. Waveform signal transition data from the active simulation

When analyzing issues:
- Cross-reference signal behavior in the waveform against the HDL logic
- Identify root causes, not just symptoms
- Suggest concrete fixes or assertions where appropriate
- Format signal names and values in backticks for readability`;

export class ChatPanel {
    private static instance: ChatPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly history: LLMMessage[] = [];
    private readonly tracker: SignalTracker;
    private readonly log: vscode.OutputChannel;
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
        if (msg.type !== 'query' || !msg.text) { return; }

        const config = vscode.workspace.getConfiguration('hdlWaveAi');
        const stepSize = config.get<number>('waveform.sampleStepSize', 1);

        const startTime = msg.startTime ?? 0;
        const endTime = msg.endTime ?? 100000;

        let contextBlock = '';

        this.log.appendLine(`[Chat] Building waveform context (t=${startTime}..${endTime}, step=${stepSize})`);
        const waveformCtx: WaveformContext | null = await buildWaveformContext(this.tracker, startTime, endTime, stepSize);
        this.log.appendLine(`[Chat] Waveform context done: ${waveformCtx ? waveformCtx.transitions.length + ' transitions' : 'null'}`);
        if (waveformCtx) {
            contextBlock += formatWaveformContext(waveformCtx);
        }

        this.log.appendLine(`[Chat] Collecting HDL context`);
        const hdlContext = await collectHdlContext();
        this.log.appendLine(`[Chat] HDL context done: ${hdlContext ? hdlContext.length + ' chars' : 'null'}`);
        if (hdlContext) {
            contextBlock += '\n\n' + hdlContext;
        }

        const userContent = contextBlock
            ? `${contextBlock}\n\n---\n\n${msg.text}`
            : msg.text;

        this.history.push({ role: 'user', content: userContent });

        const messages: LLMMessage[] = [
            { role: 'system', content: SYSTEM_PROMPT },
            ...this.history,
        ];

        try {
            const provider = createProvider();
            this.log.appendLine(`[Chat] Sending ${messages.length} messages to LLM`);
            const response = await provider.chat(messages);
            this.history.push({ role: 'assistant', content: response });
            this.panel.webview.postMessage({ type: 'response', text: response });
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.log.appendLine(`[Chat] Error: ${errMsg}`);
            this.panel.webview.postMessage({ type: 'error', text: errMsg });
        }
    }

    private dispose() {
        ChatPanel.instance = undefined;
        this.panel.dispose();
        for (const d of this.disposables) { d.dispose(); }
        this.disposables = [];
    }
}

function formatWaveformContext(ctx: WaveformContext): string {
    const lines = [
        `## Waveform Context`,
        `File: ${ctx.uri}`,
        `Time range: ${ctx.startTime} – ${ctx.endTime}`,
        `Signals: ${ctx.signals.join(', ')}`,
        ``,
        `### Signal Transitions`,
        `time | signal | value`,
        `-----|--------|------`,
    ];

    for (const t of ctx.transitions) {
        lines.push(`${t.time} | ${t.signal} | ${t.value}`);
    }

    return lines.join('\n');
}

async function collectHdlContext(): Promise<string | null> {
    const hdlFiles = await vscode.workspace.findFiles('**/*.{v,sv,vhd,vhdl}', '**/node_modules/**', 10);
    if (hdlFiles.length === 0) { return null; }

    const parts: string[] = ['## HDL Source Files'];

    for (const uri of hdlFiles) {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(bytes).toString('utf8');
        const relPath = vscode.workspace.asRelativePath(uri);
        parts.push(`\n### ${relPath}\n\`\`\`verilog\n${text}\n\`\`\``);
    }

    return parts.join('\n');
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
    white-space: pre-wrap;
    line-height: 1.5;
  }
  .message.user .bubble {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .message.assistant .bubble {
    background: var(--vscode-editor-inactiveSelectionBackground);
  }
  .message.error .bubble {
    background: var(--vscode-inputValidation-errorBackground);
    color: var(--vscode-inputValidation-errorForeground);
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
  #send {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 6px 14px;
    cursor: pointer;
    font-family: inherit;
  }
  #send:hover { background: var(--vscode-button-hoverBackground); }
  #send:disabled { opacity: 0.5; cursor: default; }
</style>
</head>
<body>
<div id="messages"></div>
<div id="input-area">
  <textarea id="input" rows="3" placeholder="Ask about your waveform or HDL design... (Shift+Enter for newline)"></textarea>
  <button id="send">Send</button>
</div>
<script>
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const sendEl = document.getElementById('send');

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

  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type === 'response') {
      addMessage('assistant', msg.text);
      sendEl.disabled = false;
    } else if (msg.type === 'error') {
      addMessage('error', 'Error: ' + msg.text);
      sendEl.disabled = false;
    }
  });
</script>
</body>
</html>`;
}
