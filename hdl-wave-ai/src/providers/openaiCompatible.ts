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
import OpenAI from 'openai';
import { LLMMessage, LLMProvider, ToolDefinition, ToolProgressEvent } from './llm';

export class OpenAICompatibleClient implements LLMProvider {
    private client: OpenAI;
    private model: string;
    private useCompletions: boolean;
    private maxPromptTokens: number;
    private maxToolRounds: number;

    constructor(baseURL: string, apiKey: string, model: string, useCompletions = false, maxPromptTokens = 28000, maxToolRounds = 0) {
        this.client = new OpenAI({ baseURL, apiKey: apiKey || 'ollama' });
        this.model = model;
        this.useCompletions = useCompletions;
        this.maxPromptTokens = maxPromptTokens;
        // 0 = auto: derive from token budget
        this.maxToolRounds = maxToolRounds > 0
            ? maxToolRounds
            : Math.max(5, Math.min(30, Math.floor(maxPromptTokens / 2000)));
    }

    // ── ChatML formatting for completions endpoint ──────────────────────

    private formatChatML(messages: LLMMessage[], addGenPrefix = true): string {
        let prompt = '';
        for (const m of messages) {
            prompt += `<|im_start|>${m.role}\n${m.content}<|im_end|>\n`;
        }
        if (addGenPrefix) {
            prompt += '<|im_start|>assistant\n';
        }
        return prompt;
    }

    private formatToolMessages(
        messages: LLMMessage[],
        toolResults: { role: string; name?: string; content: string }[],
    ): string {
        let prompt = '';
        for (const m of messages) {
            prompt += `<|im_start|>${m.role}\n${m.content}<|im_end|>\n`;
        }
        for (const tr of toolResults) {
            if (tr.role === 'assistant') {
                prompt += `<|im_start|>assistant\n${tr.content}<|im_end|>\n`;
            } else if (tr.role === 'tool') {
                prompt += `<|im_start|>user\n<tool_response>\n${tr.content}\n</tool_response><|im_end|>\n`;
            }
        }
        prompt += '<|im_start|>assistant\n';
        return prompt;
    }

    // ── Parse <tool_call> blocks from model text output ─────────────────

    private parseToolCalls(text: string): { name: string; arguments: Record<string, unknown> }[] {
        const calls: { name: string; arguments: Record<string, unknown> }[] = [];
        const regex = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
        let match;
        while ((match = regex.exec(text)) !== null) {
            try {
                const parsed = JSON.parse(match[1]);
                if (parsed.name && parsed.arguments) {
                    calls.push({ name: parsed.name, arguments: parsed.arguments });
                }
            } catch { /* skip malformed */ }
        }
        return calls;
    }

    // ── Tool schema as system prompt text (for completions mode) ────────

    private formatToolsForPrompt(tools: ToolDefinition[]): string {
        const toolDefs = tools.map(t => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
        return `\n\n# Tools\n\nYou have access to the following tools. To call a tool, output a <tool_call> block:\n\n<tool_call>\n{"name": "tool_name", "arguments": {"param": "value"}}\n</tool_call>\n\nYou may call multiple tools. After tool results are provided, continue your analysis.\n\nAvailable tools:\n${JSON.stringify(toolDefs, null, 2)}`;
    }

    // ── chat() ──────────────────────────────────────────────────────────

    async chat(messages: LLMMessage[]): Promise<string> {
        if (this.useCompletions) {
            const response = await this.client.completions.create({
                model: this.model,
                prompt: this.formatChatML(messages),
                max_tokens: 4096,
                stop: ['<|im_end|>'],
            });
            return response.choices[0]?.text ?? '';
        }

        const response = await this.client.chat.completions.create({
            model: this.model,
            messages: messages.map(m => ({ role: m.role, content: m.content })),
        });
        return response.choices[0]?.message?.content ?? '';
    }

    // ── stream() ────────────────────────────────────────────────────────

    async *stream(messages: LLMMessage[], signal?: AbortSignal): AsyncGenerator<string> {
        if (this.useCompletions) {
            const stream = await this.client.completions.create({
                model: this.model,
                prompt: this.formatChatML(messages),
                max_tokens: 4096,
                stop: ['<|im_end|>'],
                stream: true,
            }, { signal });

            for await (const chunk of stream) {
                if (signal?.aborted) { break; }
                const text = chunk.choices[0]?.text;
                if (text) { yield text; }
            }
            return;
        }

        const stream = await this.client.chat.completions.create({
            model: this.model,
            messages: messages.map(m => ({ role: m.role, content: m.content })),
            stream: true,
        }, { signal });

        for await (const chunk of stream) {
            if (signal?.aborted) { break; }
            const delta = chunk.choices[0]?.delta?.content;
            if (delta) { yield delta; }
        }
    }

    // ── chatWithTools() ─────────────────────────────────────────────────

    async chatWithTools(
        messages: LLMMessage[],
        tools: ToolDefinition[],
        toolExecutor: (name: string, args: Record<string, unknown>) => string,
        signal?: AbortSignal,
        onProgress?: (event: ToolProgressEvent) => void,
        hdlContext?: string,
    ): Promise<string> {
        if (this.useCompletions) {
            return this.chatWithToolsCompletions(messages, tools, toolExecutor, signal, onProgress, hdlContext);
        }
        return this.chatWithToolsChat(messages, tools, toolExecutor, signal, onProgress, hdlContext);
    }

    // ── Tool loop via /v1/completions (ChatML + text parsing) ───────────

    /** Estimate tokens from a character count. Conservative ratio for ChatML + JSON. */
    private charsToTokens(chars: number): number {
        return Math.ceil(chars / 2.5);
    }

    /**
     * Ensure a ChatML prompt fits within the token budget.
     * Trims tool history first, then truncates the user message's HDL context block as a last resort.
     */
    private fitPromptToBudget(
        msgs: LLMMessage[],
        toolHistory: { role: string; name?: string; content: string }[],
        maxTokens: number,
    ): void {
        const measure = () => {
            const prompt = this.formatToolMessages(msgs, toolHistory);
            return this.charsToTokens(prompt.length);
        };

        // Phase 1: trim tool history (keep first 2 = list_signals)
        while (toolHistory.length > 2 && measure() > maxTokens) {
            toolHistory.splice(2, 1);
        }

        // Phase 2: if still over, truncate HDL context in user message
        if (measure() > maxTokens) {
            const userIdx = msgs.findIndex(m => m.role === 'user');
            if (userIdx >= 0) {
                const hdlMarker = '## HDL Source';
                const hdlStart = msgs[userIdx].content.indexOf(hdlMarker);
                if (hdlStart >= 0) {
                    const overshoot = measure() - maxTokens;
                    const charsToRemove = Math.ceil(overshoot * 2.5) + 500; // extra buffer
                    const currentHdl = msgs[userIdx].content.slice(hdlStart);
                    const trimmedHdl = currentHdl.slice(0, Math.max(0, currentHdl.length - charsToRemove));
                    msgs[userIdx] = {
                        ...msgs[userIdx],
                        content: msgs[userIdx].content.slice(0, hdlStart) + (trimmedHdl.length > 100 ? trimmedHdl + '\n// ... (truncated to fit token budget)' : ''),
                    };
                }
            }
        }

        // Phase 3: nuclear option — if still over, just truncate the entire user message
        if (measure() > maxTokens) {
            const userIdx = msgs.findIndex(m => m.role === 'user');
            if (userIdx >= 0) {
                const maxChars = maxTokens * 2.5;
                const otherChars = msgs.filter((_, i) => i !== userIdx).reduce((s, m) => s + m.content.length, 0)
                    + toolHistory.reduce((s, t) => s + t.content.length, 0);
                const userBudget = Math.max(500, maxChars - otherChars - 1000);
                msgs[userIdx] = {
                    ...msgs[userIdx],
                    content: msgs[userIdx].content.slice(0, userBudget) + '\n// ... (truncated to fit token budget)',
                };
            }
        }
    }

    private async chatWithToolsCompletions(
        messages: LLMMessage[],
        tools: ToolDefinition[],
        toolExecutor: (name: string, args: Record<string, unknown>) => string,
        signal?: AbortSignal,
        onProgress?: (event: ToolProgressEvent) => void,
        hdlContext?: string,
    ): Promise<string> {
        // Inject tool definitions into the system message
        const msgs = messages.map(m => ({ ...m }));
        const sysIdx = msgs.findIndex(m => m.role === 'system');
        if (sysIdx >= 0) {
            msgs[sysIdx].content += this.formatToolsForPrompt(tools);
        } else {
            msgs.unshift({ role: 'system', content: this.formatToolsForPrompt(tools) });
        }

        // Pre-execute list_signals and inject as context
        const listResult = toolExecutor('list_signals', {});
        const toolHistory: { role: string; name?: string; content: string }[] = [];
        toolHistory.push({
            role: 'assistant',
            content: '<tool_call>\n{"name": "list_signals", "arguments": {}}\n</tool_call>',
        });
        toolHistory.push({ role: 'tool', name: 'list_signals', content: listResult });

        // Pre-seed: use snapshot at range boundaries instead of bulk query_transitions.
        // This is far more token-efficient and gives the model a good starting picture.
        const userMsg = [...messages].reverse().find(m => m.role === 'user');
        const rangeMatch = userMsg?.content.match(/t_start=(\d+)[\s\S]*?t_end=(\d+)/);
        if (rangeMatch) {
            const tStart = Number(rangeMatch[1]);
            const tEnd = Number(rangeMatch[2]);

            // Snapshot at start and end of range
            const startSnap = toolExecutor('snapshot', { time: tStart });
            const endSnap = toolExecutor('snapshot', { time: tEnd });
            toolHistory.push({
                role: 'assistant',
                content: `<tool_call>\n{"name": "snapshot", "arguments": {"time": ${tStart}}}\n</tool_call>\n<tool_call>\n{"name": "snapshot", "arguments": {"time": ${tEnd}}}\n</tool_call>`,
            });
            toolHistory.push({ role: 'tool', name: 'snapshot', content: startSnap });
            toolHistory.push({ role: 'tool', name: 'snapshot', content: endSnap });
        }

        // Token budget: leave room for output (4096) + overhead
        const maxPromptTokens = this.maxPromptTokens - 4096;

        // Tool loop
        for (let round = 0; round < this.maxToolRounds; round++) {
            if (signal?.aborted) { return ''; }

            // Fit prompt within token budget
            this.fitPromptToBudget(msgs, toolHistory, maxPromptTokens);

            const prompt = this.formatToolMessages(msgs, toolHistory);
            const response = await this.client.completions.create({
                model: this.model,
                prompt,
                max_tokens: 4096,
                stop: ['<|im_end|>'],
            });

            const text = response.choices[0]?.text ?? '';
            const toolCalls = this.parseToolCalls(text);

            if (toolCalls.length === 0) {
                // No tool calls — this is the final response.
                // Fit before final response too
                this.fitPromptToBudget(msgs, toolHistory, maxPromptTokens);
                return await this.streamFinalResponseCompletions(msgs, toolHistory, signal, onProgress, hdlContext);
            }

            // Execute tool calls
            toolHistory.push({ role: 'assistant', content: text });
            for (const tc of toolCalls) {
                onProgress?.({ type: 'tool_call', name: tc.name, args: tc.arguments });
                const result = toolExecutor(tc.name, tc.arguments);
                toolHistory.push({ role: 'tool', name: tc.name, content: result });
            }
        }
        return 'Tool loop exceeded maximum rounds without a final answer.';
    }

    /** Stream the final response via completions endpoint. */
    private async streamFinalResponseCompletions(
        msgs: LLMMessage[],
        toolHistory: { role: string; name?: string; content: string }[],
        signal?: AbortSignal,
        onProgress?: (event: ToolProgressEvent) => void,
        _hdlContext?: string,
    ): Promise<string> {
        // HDL context is already in the user message — don't re-inject it here
        // to avoid blowing the token budget. The model has it from the initial prompt.

        const finalMsgs: LLMMessage[] = [...msgs, {
            role: 'user' as const,
            content: `Now provide your analysis as plain text (no tool calls).

Structure your response as:
## System Overview — Identify the design from HDL modules.
## Key Events Timeline — 3-5 significant events with timestamps, RTL citations, and decoded values.
## Signal Correlations — Cross-module dependencies with RTL line quotes.
## Summary — What the circuit is doing overall.

RULES: Cite exact RTL lines. Decode hex values in context. Depth over breadth.`,
        }];

        // Enforce budget on the final prompt (which includes all tool history)
        const maxPromptTokens = this.maxPromptTokens - 4096;
        this.fitPromptToBudget(finalMsgs, toolHistory, maxPromptTokens);

        const prompt = this.formatToolMessages(finalMsgs, toolHistory);

        if (!onProgress) {
            const resp = await this.client.completions.create({
                model: this.model,
                prompt,
                max_tokens: 4096,
                stop: ['<|im_end|>'],
            });
            return resp.choices[0]?.text ?? '';
        }

        const stream = await this.client.completions.create({
            model: this.model,
            prompt,
            max_tokens: 4096,
            stop: ['<|im_end|>'],
            stream: true,
        }, { signal });

        let full = '';
        for await (const chunk of stream) {
            if (signal?.aborted) { break; }
            const text = chunk.choices[0]?.text;
            if (text) {
                full += text;
                onProgress({ type: 'chunk', text });
            }
        }
        return full;
    }

    // ── Tool loop via /v1/chat/completions (native function calling) ────

    private async chatWithToolsChat(
        messages: LLMMessage[],
        tools: ToolDefinition[],
        toolExecutor: (name: string, args: Record<string, unknown>) => string,
        signal?: AbortSignal,
        onProgress?: (event: ToolProgressEvent) => void,
        hdlContext?: string,
    ): Promise<string> {
        const oaiTools: OpenAI.ChatCompletionTool[] = tools.map(t => ({
            type: 'function' as const,
            function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters as Record<string, unknown>,
            },
        }));

        const msgs: OpenAI.ChatCompletionMessageParam[] = messages.map(m => ({
            role: m.role,
            content: m.content,
        }));

        // Pre-execute list_signals and inject it into the conversation.
        // Ollama ignores tool_choice:'required', so we seed real data upfront
        // to prevent hallucination on the first round.
        const listResult = toolExecutor('list_signals', {});
        const fakeCallId = 'preseed_list_signals';
        msgs.push({
            role: 'assistant',
            content: null,
            tool_calls: [{
                id: fakeCallId,
                type: 'function',
                function: { name: 'list_signals', arguments: '{}' },
            }],
        });
        msgs.push({ role: 'tool', tool_call_id: fakeCallId, content: listResult });

        // Pre-seed: snapshot at range boundaries for an efficient overview.
        const userMsg = [...messages].reverse().find(m => m.role === 'user');
        const rangeMatch = userMsg?.content.match(/t_start=(\d+)[\s\S]*?t_end=(\d+)/);
        if (rangeMatch) {
            const tStart = Number(rangeMatch[1]);
            const tEnd = Number(rangeMatch[2]);

            const startSnapId = 'preseed_snap_start';
            const endSnapId = 'preseed_snap_end';
            const startResult = toolExecutor('snapshot', { time: tStart });
            const endResult = toolExecutor('snapshot', { time: tEnd });

            msgs.push({
                role: 'assistant',
                content: null,
                tool_calls: [
                    { id: startSnapId, type: 'function', function: { name: 'snapshot', arguments: JSON.stringify({ time: tStart }) } },
                    { id: endSnapId, type: 'function', function: { name: 'snapshot', arguments: JSON.stringify({ time: tEnd }) } },
                ],
            });
            msgs.push({ role: 'tool', tool_call_id: startSnapId, content: startResult });
            msgs.push({ role: 'tool', tool_call_id: endSnapId, content: endResult });
        }

        for (let round = 0; round < this.maxToolRounds; round++) {
            if (signal?.aborted) { return ''; }

            const response = await this.client.chat.completions.create({
                model: this.model,
                messages: msgs,
                tools: oaiTools,
                tool_choice: 'auto',
            }, { signal });

            const message = response.choices[0]?.message;
            if (!message) { break; }
            msgs.push(message);

            if (!message.tool_calls?.length) {
                // Always re-prompt without tools for the final response.
                // This ensures streaming works AND gives the model a clean
                // break from tool mode, producing better analysis text.
                return await this.streamFinalResponse(msgs, signal, onProgress, hdlContext);
            }

            for (const tc of message.tool_calls) {
                let args: Record<string, unknown> = {};
                try { args = JSON.parse(tc.function.arguments); } catch { /* ignore */ }
                onProgress?.({ type: 'tool_call', name: tc.function.name, args });
                const result = toolExecutor(tc.function.name, args);
                msgs.push({ role: 'tool', tool_call_id: tc.id, content: result });
            }
        }
        return 'Tool loop exceeded maximum rounds without a final answer.';
    }

    /** Stream the final LLM response (after tool calls) and emit chunks via onProgress. */
    private async streamFinalResponse(
        msgs: OpenAI.ChatCompletionMessageParam[],
        signal?: AbortSignal,
        onProgress?: (event: ToolProgressEvent) => void,
        _hdlContext?: string,
    ): Promise<string> {
        // HDL context is already in the conversation — don't re-inject to save tokens
        const finalMsgs: OpenAI.ChatCompletionMessageParam[] = [...msgs, {
            role: 'user' as const,
            content: `Now provide your analysis as plain text (no JSON, no tool calls).

Structure your response as follows:

## System Overview
Briefly identify the design (e.g. CPU architecture, SoC components) based on the HDL modules.

## Key Events Timeline
For the 3-5 most significant events in the time range:
- **t=<timestamp>**: Describe what happened and why.
- Quote the specific RTL line that explains the behavior (e.g. \`assign X = Y ? A : B;\` from module_name).
- Decode any data values in context (e.g. "0x00050663 on IDATA is a BEQ instruction: opcode=1100011, funct3=000, branch offset=12").

## Signal Correlations
Explain how signals interact across modules. For each claim, cite the RTL line that creates the dependency.

## Summary
What is the circuit doing overall during this time window? (e.g. "The CPU is executing a loop that reads from peripheral registers and branches based on the result.")

RULES:
- Do NOT list raw hex values without explaining what they mean in circuit context.
- Every RTL reference must be an exact quote from the HDL source provided — never paraphrase or invent code.
- Focus on depth over breadth: analyze a few events thoroughly rather than many events superficially.`,
        }];

        if (!onProgress) {
            const resp = await this.client.chat.completions.create({
                model: this.model,
                messages: finalMsgs,
            }, { signal });
            return resp.choices[0]?.message?.content ?? '';
        }

        const stream = await this.client.chat.completions.create({
            model: this.model,
            messages: finalMsgs,
            stream: true,
        }, { signal });

        let full = '';
        for await (const chunk of stream) {
            if (signal?.aborted) { break; }
            const delta = chunk.choices[0]?.delta?.content;
            if (delta) {
                full += delta;
                onProgress({ type: 'chunk', text: delta });
            }
        }
        return full;
    }
}
