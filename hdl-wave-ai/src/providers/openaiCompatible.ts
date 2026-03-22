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
import { LLMMessage, LLMProvider, ToolDefinition, ToolLoopOptions, ToolProgressEvent } from './llm';

const FINAL_ANALYSIS_PROMPT = `Now provide your final analysis using ONLY the data you gathered from tool calls. No more tool calls.

IMPORTANT: Adapt your analysis to the ACTUAL design. Do NOT assume this is a CPU — it could be a systolic array, DSP, accelerator, peripheral controller, or any digital design. Only include sections that are relevant to the signals you observed. Never fabricate instruction traces, assembly code, or program counters for designs that don't have them.

## System Overview
One paragraph: what is this design? Describe the actual architecture based on the signal names and HDL modules you can see.

## Signal Trace
Build a table of the key signal transitions you queried. Include timestamps, signal names, and values.
For CPU designs with PC/IADDR signals, include decoded instructions (from decode_instruction results ONLY).
For non-CPU designs, trace the state machine, control signals, and data flow instead.

| Time | Signal | Value | Meaning |
|------|--------|-------|---------|
| ... | ... | ... | ... |

## Key Events
Pick 3-5 important moments from the trace (state transitions, data transfers, handshakes, stalls, errors).
For each event:
- What happened and WHY (not just what signal changed)
- Quote the exact RTL line from the HDL source that explains it
- Connect cause to effect across signals

## Data Flow
Summarize the data movement observed:
- What data was transferred and between which interfaces?
- What control signals governed the transfers?
- Were there any stalls, backpressure, or error conditions?

## Summary
2-3 sentences: What is this design doing in plain English during the analyzed time window?

RULES:
- Only use data from your tool call results — never guess or fabricate values.
- Every RTL citation must be an exact quote from the provided HDL source.
- If you did not call decode_instruction(), do NOT write assembly mnemonics.
- If the design has no program counter, do NOT invent one.
- If you did not query a signal, do NOT guess its value. `;

/**
 * Strip <think>...</think> blocks that reasoning models (Qwen 3, DeepSeek, etc.)
 * emit before their actual answer. Works on complete text.
 */
function stripThinkingTags(text: string): string {
    // Remove all <think>...</think> blocks (greedy, handles newlines)
    return text.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trimStart();
}

/**
 * Streaming filter that buffers text until any leading <think>...</think> block
 * is fully received and stripped, then passes through remaining chunks unchanged.
 */
class ThinkingStreamFilter {
    private buffer = '';
    private pastThinking = false;

    /** Feed a chunk; returns the text to emit (may be empty while buffering). */
    push(chunk: string): string {
        if (this.pastThinking) { return chunk; }

        this.buffer += chunk;

        // If we haven't seen <think> at all and have enough text to be sure
        if (!this.buffer.startsWith('<think') && this.buffer.length > 10) {
            this.pastThinking = true;
            const out = this.buffer;
            this.buffer = '';
            return out;
        }

        // Still might be inside a <think> block — check for closing tag
        const closeIdx = this.buffer.indexOf('</think>');
        if (closeIdx >= 0) {
            this.pastThinking = true;
            const afterThink = this.buffer.slice(closeIdx + '</think>'.length).trimStart();
            this.buffer = '';
            return afterThink;
        }

        // Still buffering — don't emit yet
        return '';
    }

    /** Flush any remaining buffer (in case </think> was never closed). */
    flush(): string {
        if (this.buffer) {
            const out = stripThinkingTags(this.buffer);
            this.buffer = '';
            return out;
        }
        return '';
    }
}

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
        // 0 = auto: aim for 5-12 rounds (each round may have multiple parallel calls)
        this.maxToolRounds = maxToolRounds > 0
            ? maxToolRounds
            : Math.max(5, Math.min(12, Math.floor(maxPromptTokens / 4000)));
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
        options?: ToolLoopOptions,
    ): Promise<string> {
        if (this.useCompletions) {
            return this.chatWithToolsCompletions(messages, tools, toolExecutor, signal, onProgress, hdlContext, options);
        }
        return this.chatWithToolsChat(messages, tools, toolExecutor, signal, onProgress, hdlContext, options);
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

        // Phase 1: trim tool history, but protect instruction-related results.
        // First pass: remove non-essential entries (snapshots, non-INSTR queries) from oldest.
        // Second pass: if still over, remove anything from oldest.
        const isInstrResult = (entry: { role: string; name?: string; content: string }) =>
            entry.role === 'tool' && entry.content && /→\s*\w/.test(entry.content);

        // Pass 1: remove non-instruction tool results from oldest (skip first 2 = list_signals)
        let idx = 2;
        while (idx < toolHistory.length && measure() > maxTokens) {
            if (!isInstrResult(toolHistory[idx])) {
                toolHistory.splice(idx, 1);
            } else {
                idx++;
            }
        }
        // Pass 2: if still over, remove anything from oldest
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
        options?: ToolLoopOptions,
    ): Promise<string> {
        // Inject tool definitions into the system message
        const msgs = messages.map(m => ({ ...m }));
        const sysIdx = msgs.findIndex(m => m.role === 'system');
        if (sysIdx >= 0) {
            msgs[sysIdx].content += this.formatToolsForPrompt(tools);
        } else {
            msgs.unshift({ role: 'system', content: this.formatToolsForPrompt(tools) });
        }

        // Pre-execute list_signals so the model knows what's available.
        // Do NOT pre-seed snapshots — let the model make its own tool calls
        // to encourage deeper investigation instead of short-circuiting to analysis.
        const listResult = toolExecutor('list_signals', {});
        const toolHistory: { role: string; name?: string; content: string }[] = [];
        toolHistory.push({
            role: 'assistant',
            content: '<tool_call>\n{"name": "list_signals", "arguments": {}}\n</tool_call>',
        });
        toolHistory.push({ role: 'tool', name: 'list_signals', content: listResult });

        // Token budget: leave room for output (4096) + overhead
        const maxPromptTokens = this.maxPromptTokens - 4096;

        // Tool loop — force tool use for first few rounds
        const minForcedRounds = options?.allowDirectAnswer ? 0 : Math.min(3, this.maxToolRounds);
        let totalToolCalls = 0;
        const queriedSignals = new Set<string>();

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
                if (round < minForcedRounds) {
                    // Model tried to stop too early — nudge it to keep going
                    toolHistory.push({
                        role: 'assistant',
                        content: text || 'I need to gather more data before analyzing.',
                    });
                    toolHistory.push({
                        role: 'tool',
                        name: 'system',
                        content: `[You have only made ${totalToolCalls} tool calls. Please make more calls before writing your analysis. Try snapshot(), query_transitions() on control signals, or decode_instruction().]`,
                    });
                    continue;
                }
                // No tool calls — this is the final response.
                // Fit before final response too
                this.fitPromptToBudget(msgs, toolHistory, maxPromptTokens);
                return await this.streamFinalResponseCompletions(msgs, toolHistory, signal, onProgress, hdlContext);
            }

            // Deduplicate tool calls (small models often repeat the same call)
            const seen = new Set<string>();
            const uniqueCalls = toolCalls.filter(tc => {
                const key = JSON.stringify({ n: tc.name, a: tc.arguments });
                if (seen.has(key)) { return false; }
                seen.add(key);
                return true;
            });

            // Execute tool calls
            toolHistory.push({ role: 'assistant', content: text });
            for (const tc of uniqueCalls) {
                onProgress?.({ type: 'tool_call', name: tc.name, args: tc.arguments });
                const result = toolExecutor(tc.name, tc.arguments);
                toolHistory.push({ role: 'tool', name: tc.name, content: result });
                // Track queried signals
                if (tc.arguments.signal && typeof tc.arguments.signal === 'string') {
                    queriedSignals.add(tc.arguments.signal);
                }
                totalToolCalls++;
            }

            // Inject progress nudge — encourage early, then tell model to wrap up
            {
                const remaining = this.maxToolRounds - round - 1;
                let hint: string;
                if (totalToolCalls < 5) {
                    const signalList = [...queriedSignals].join(', ');
                    hint = `[Progress: ${totalToolCalls} call(s), ${remaining} rounds left. Signals queried: ${signalList || 'none'}. Make more tool calls before writing analysis.]`;
                } else if (totalToolCalls < 15) {
                    hint = `[Progress: ${totalToolCalls} call(s), ${remaining} rounds left. You have good data — a few more targeted calls then write your analysis.]`;
                } else {
                    hint = `[You have made ${totalToolCalls} tool calls. You have sufficient data. Stop calling tools and write your final analysis now.]`;
                }
                toolHistory.push({ role: 'tool', name: 'system', content: hint });
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
            content: FINAL_ANALYSIS_PROMPT,
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
            return stripThinkingTags(resp.choices[0]?.text ?? '');
        }

        const stream = await this.client.completions.create({
            model: this.model,
            prompt,
            max_tokens: 4096,
            stop: ['<|im_end|>'],
            stream: true,
        }, { signal });

        let full = '';
        const filter = new ThinkingStreamFilter();
        for await (const chunk of stream) {
            if (signal?.aborted) { break; }
            const text = chunk.choices[0]?.text;
            if (text) {
                const filtered = filter.push(text);
                if (filtered) {
                    full += filtered;
                    onProgress({ type: 'chunk', text: filtered });
                }
            }
        }
        const remaining = filter.flush();
        if (remaining) {
            full += remaining;
            onProgress({ type: 'chunk', text: remaining });
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
        options?: ToolLoopOptions,
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

        // Pre-execute list_signals so the model knows what's available.
        // Do NOT pre-seed snapshots — let the model make its own tool calls.
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

        // Force tool use for the first few rounds to ensure sufficient data gathering
        const minForcedRounds = options?.allowDirectAnswer ? 0 : Math.min(3, this.maxToolRounds);
        let totalToolCalls = 0;
        const queriedSignals = new Set<string>();

        for (let round = 0; round < this.maxToolRounds; round++) {
            if (signal?.aborted) { return ''; }

            // Force tool calling for the first minForcedRounds
            const toolChoiceParam = round < minForcedRounds ? 'required' as const : 'auto' as const;

            const response = await this.client.chat.completions.create({
                model: this.model,
                messages: msgs,
                tools: oaiTools,
                tool_choice: toolChoiceParam,
            }, { signal });

            const message = response.choices[0]?.message;
            if (!message) { break; }
            msgs.push(message);

            if (!message.tool_calls?.length) {
                if (round < minForcedRounds) {
                    // Model tried to stop too early — nudge it back to tool calling
                    msgs.push({
                        role: 'user' as const,
                        content: `You have only made ${totalToolCalls} tool call(s). You MUST make more tool calls before writing your analysis. Call snapshot(), query_transitions(), or decode_instruction() now.`,
                    });
                    continue;
                }
                // Past forced rounds — produce final analysis via clean re-prompt
                return await this.streamFinalResponse(msgs, signal, onProgress, hdlContext);
            }

            // Deduplicate tool calls (small models often repeat the same call)
            const seen = new Map<string, string>(); // key → cached result
            for (const tc of message.tool_calls) {
                let args: Record<string, unknown> = {};
                try { args = JSON.parse(tc.function.arguments); } catch { /* ignore */ }
                const dedupKey = JSON.stringify({ n: tc.function.name, a: args });
                let result: string;
                if (seen.has(dedupKey)) {
                    result = `[DUPLICATE — same result as previous identical call]\n${seen.get(dedupKey)!}`;
                } else {
                    onProgress?.({ type: 'tool_call', name: tc.function.name, args });
                    result = toolExecutor(tc.function.name, args);
                    seen.set(dedupKey, result);
                }
                // Track queried signals
                if (args.signal && typeof args.signal === 'string') {
                    queriedSignals.add(args.signal as string);
                }
                totalToolCalls++;
                // Must respond to every tool_call id or the API rejects it
                msgs.push({ role: 'tool', tool_call_id: tc.id, content: result });
            }

            // Inject progress nudge — encourage early, then tell model to wrap up
            {
                const remaining = this.maxToolRounds - round - 1;
                let hint: string;
                if (totalToolCalls < 5) {
                    const signalList = [...queriedSignals].join(', ');
                    hint = `[Progress: ${totalToolCalls} call(s), ${remaining} rounds left. Signals queried: ${signalList || 'none'}. Make more calls — try snapshot(), query_transitions() on control signals, or decode_instruction().]`;
                } else if (totalToolCalls < 15) {
                    hint = `[Progress: ${totalToolCalls} call(s), ${remaining} rounds left. You have good data — a few more targeted calls then write your analysis.]`;
                } else {
                    hint = `[You have made ${totalToolCalls} tool calls. You have sufficient data. Stop calling tools and write your final analysis now.]`;
                }
                // Append hint to the last tool result
                const lastToolMsg = msgs[msgs.length - 1];
                if (lastToolMsg.role === 'tool' && typeof lastToolMsg.content === 'string') {
                    (lastToolMsg as { content: string }).content += '\n\n' + hint;
                }
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
            content: FINAL_ANALYSIS_PROMPT,
        }];

        if (!onProgress) {
            const resp = await this.client.chat.completions.create({
                model: this.model,
                messages: finalMsgs,
            }, { signal });
            return stripThinkingTags(resp.choices[0]?.message?.content ?? '');
        }

        const stream = await this.client.chat.completions.create({
            model: this.model,
            messages: finalMsgs,
            stream: true,
        }, { signal });

        let full = '';
        const filter = new ThinkingStreamFilter();
        for await (const chunk of stream) {
            if (signal?.aborted) { break; }
            const delta = chunk.choices[0]?.delta?.content;
            if (delta) {
                const filtered = filter.push(delta);
                if (filtered) {
                    full += filtered;
                    onProgress({ type: 'chunk', text: filtered });
                }
            }
        }
        const remaining = filter.flush();
        if (remaining) {
            full += remaining;
            onProgress({ type: 'chunk', text: remaining });
        }
        return full;
    }
}
