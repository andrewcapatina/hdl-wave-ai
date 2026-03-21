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
import Anthropic from '@anthropic-ai/sdk';
import { LLMMessage, LLMProvider, ToolDefinition, ToolProgressEvent } from './llm';

const FINAL_ANALYSIS_PROMPT = `Now provide your final analysis using ONLY the data you gathered from tool calls. No more tool calls.
Do NOT include your reasoning process or chain-of-thought. Write ONLY the structured analysis.

IMPORTANT: Adapt your analysis to the ACTUAL design. Do NOT assume this is a CPU — it could be a systolic array, DSP, accelerator, peripheral controller, or any digital design. Only include sections that are relevant to the signals you observed. Never fabricate instruction traces, assembly code, or program counters for designs that don't have them.

## System Overview
One paragraph: what is this design? Describe the actual architecture based on the signal names and HDL modules you can see. (e.g. CPU with pipeline stages, systolic array for matrix math, DMA controller, UART, etc.)

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
`;

export class AnthropicClient implements LLMProvider {
    private client: Anthropic;
    private model: string;
    private maxToolRounds: number;

    constructor(apiKey: string, model: string, maxToolRounds = 0, maxPromptTokens = 200000) {
        this.client = new Anthropic({ apiKey });
        this.model = model;
        // Auto-calculate: aim for 5-12 rounds (each round may have multiple parallel tool calls).
        // 12 rounds × ~3 calls/round ≈ 36 calls, which is plenty for thorough analysis.
        this.maxToolRounds = maxToolRounds > 0
            ? maxToolRounds
            : Math.max(5, Math.min(12, Math.floor(maxPromptTokens / 4000)));
    }

    async chat(messages: LLMMessage[]): Promise<string> {
        const systemMsg = messages.find(m => m.role === 'system');
        const conversationMessages = messages
            .filter(m => m.role !== 'system')
            .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

        const response = await this.client.messages.create({
            model: this.model,
            max_tokens: 4096,
            system: systemMsg?.content,
            messages: conversationMessages,
        });

        const block = response.content[0];
        return block.type === 'text' ? block.text : '';
    }

    async *stream(messages: LLMMessage[], signal?: AbortSignal): AsyncGenerator<string> {
        const systemMsg = messages.find(m => m.role === 'system');
        const conversationMessages = messages
            .filter(m => m.role !== 'system')
            .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

        const stream = this.client.messages.stream({
            model: this.model,
            max_tokens: 4096,
            system: systemMsg?.content,
            messages: conversationMessages,
        }, { signal });

        for await (const event of stream) {
            if (signal?.aborted) { break; }
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                yield event.delta.text;
            }
        }
    }

    async chatWithTools(
        messages: LLMMessage[],
        tools: ToolDefinition[],
        toolExecutor: (name: string, args: Record<string, unknown>) => string,
        signal?: AbortSignal,
        onProgress?: (event: ToolProgressEvent) => void,
        _hdlContext?: string,
    ): Promise<string> {
        const anthropicTools: Anthropic.Tool[] = tools.map(t => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters as Anthropic.Tool['input_schema'],
        }));

        const systemMsg = messages.find(m => m.role === 'system');
        const msgs: Anthropic.MessageParam[] = messages
            .filter(m => m.role !== 'system')
            .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

        // Track which signals/timestamps have been queried to prevent duplicates
        // and to generate progress hints.
        const queriedSignals = new Set<string>();
        let totalToolCalls = 0;

        // Force tool use for the first few rounds to ensure sufficient investigation.
        const minForcedRounds = Math.min(3, this.maxToolRounds);

        for (let round = 0; round < this.maxToolRounds; round++) {
            if (signal?.aborted) { return ''; }

            // Force tool use for the first minForcedRounds to ensure the model
            // gathers enough data before attempting analysis.
            const toolChoice: Anthropic.MessageCreateParams['tool_choice'] =
                round < minForcedRounds ? { type: 'any' } : { type: 'auto' };

            const response = await this.client.messages.create({
                model: this.model,
                max_tokens: 4096,
                system: systemMsg?.content,
                messages: msgs,
                tools: anthropicTools,
                tool_choice: toolChoice,
            });

            const toolUseBlocks = response.content.filter(
                (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
            );

            // Only exit when there are NO tool blocks AND we're past forced rounds.
            // During forced rounds, if the model somehow returns no tools, nudge it.
            if (!toolUseBlocks.length) {
                if (round < minForcedRounds) {
                    // Model tried to stop too early — push it back to tool use
                    msgs.push({ role: 'assistant', content: response.content });
                    msgs.push({
                        role: 'user',
                        content: `You have only made ${totalToolCalls} tool call(s). You MUST make more tool calls before writing your analysis. Call snapshot(), query_transitions(), or decode_instruction() now.`,
                    });
                    continue;
                }
                // Past forced rounds — produce final analysis via a clean re-prompt
                break;
            }

            // Process tool calls even if stop_reason is 'end_turn' — the model
            // may have included both text and tool blocks in the same response.
            msgs.push({ role: 'assistant', content: response.content });

            // Deduplicate tool calls (small models often repeat the same call)
            const seen = new Map<string, string>();
            const toolResults: Anthropic.ToolResultBlockParam[] = toolUseBlocks.map(b => {
                const key = JSON.stringify({ n: b.name, a: b.input });
                const input = b.input as Record<string, unknown>;
                let result: string;
                if (seen.has(key)) {
                    result = `[DUPLICATE — same result as previous identical call]\n${seen.get(key)!}`;
                } else {
                    onProgress?.({ type: 'tool_call', name: b.name, args: input });
                    result = toolExecutor(b.name, input);
                    seen.set(key, result);
                }
                // Track queried signals for progress hints
                if (input.signal && typeof input.signal === 'string') {
                    queriedSignals.add(input.signal);
                }
                totalToolCalls++;
                return { type: 'tool_result' as const, tool_use_id: b.id, content: result };
            });

            // Append progress hint to the last tool result (not as a separate result
            // — Anthropic requires exactly one result per tool_use_id).
            {
                const remaining = this.maxToolRounds - round - 1;
                let hint: string;
                if (totalToolCalls < 5) {
                    const signalList = [...queriedSignals].join(', ');
                    hint = `\n\n[Progress: ${totalToolCalls} call(s), ${remaining} rounds left. Signals queried: ${signalList || 'none'}. Make more calls — try snapshot(), query_transitions() on control signals, or decode_instruction().]`;
                } else if (totalToolCalls < 15) {
                    hint = `\n\n[Progress: ${totalToolCalls} call(s), ${remaining} rounds left. You have good data — a few more targeted calls then write your analysis.]`;
                } else {
                    hint = `\n\n[You have made ${totalToolCalls} tool calls. You have sufficient data. Stop calling tools and write your final analysis now.]`;
                }
                const lastResult = toolResults[toolResults.length - 1];
                lastResult.content = (lastResult.content as string) + hint;
            }

            msgs.push({ role: 'user', content: toolResults });

            // Compress old tool results if context is growing too large.
            this.compressToolHistory(msgs);
        }

        // Final analysis: re-prompt the model without tools, using the structured
        // output template. This prevents chain-of-thought leaking into the response.
        return await this.streamFinalAnalysis(systemMsg?.content, msgs, signal, onProgress);
    }

    /**
     * Stream the final analysis by re-prompting without tools, using the
     * structured FINAL_ANALYSIS_PROMPT template. This ensures the model
     * produces clean output without chain-of-thought reasoning.
     */
    private async streamFinalAnalysis(
        system: string | undefined,
        msgs: Anthropic.MessageParam[],
        signal?: AbortSignal,
        onProgress?: (event: ToolProgressEvent) => void,
    ): Promise<string> {
        // Add the final analysis prompt as a user message
        const finalMsgs: Anthropic.MessageParam[] = [...msgs, {
            role: 'user' as const,
            content: FINAL_ANALYSIS_PROMPT,
        }];

        if (!onProgress) {
            const response = await this.client.messages.create({
                model: this.model,
                max_tokens: 4096,
                system,
                messages: finalMsgs,
            });
            const textBlock = response.content.find(b => b.type === 'text');
            return textBlock?.type === 'text' ? textBlock.text : '';
        }

        // Stream the response
        const stream = this.client.messages.stream({
            model: this.model,
            max_tokens: 4096,
            system,
            messages: finalMsgs,
        }, { signal });

        let full = '';
        for await (const event of stream) {
            if (signal?.aborted) { break; }
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                full += event.delta.text;
                onProgress({ type: 'chunk', text: event.delta.text });
            }
        }
        return full;
    }

    /**
     * Compress older tool results in the message history to prevent context
     * overflow. Keeps the first user message and the most recent 4 messages
     * intact, summarizing intermediate tool results.
     */
    private compressToolHistory(msgs: Anthropic.MessageParam[]): void {
        // Only compress if we have a substantial history
        if (msgs.length <= 8) { return; }

        // Estimate total content size
        const totalChars = msgs.reduce((sum, m) => {
            if (typeof m.content === 'string') { return sum + m.content.length; }
            if (Array.isArray(m.content)) {
                return sum + m.content.reduce((s, b) => {
                    if ('text' in b && typeof b.text === 'string') { return s + b.text.length; }
                    if ('content' in b && typeof b.content === 'string') { return s + b.content.length; }
                    return s + 200; // estimate for structured blocks
                }, 0);
            }
            return sum + 200;
        }, 0);

        // Only compress if we're using more than ~60% of a typical context budget
        const compressThreshold = 40000; // ~16k tokens worth of chars
        if (totalChars < compressThreshold) { return; }

        // Keep first message (user query) and last 4 messages (recent tool exchange).
        // Summarize the middle section.
        const keepHead = 1;
        const keepTail = 4;
        if (msgs.length <= keepHead + keepTail) { return; }

        const middleStart = keepHead;
        const middleEnd = msgs.length - keepTail;
        const middleMsgs = msgs.slice(middleStart, middleEnd);

        // Extract a brief summary of what tools were called
        const toolSummaries: string[] = [];
        for (const m of middleMsgs) {
            if (Array.isArray(m.content)) {
                for (const block of m.content) {
                    if ('name' in block && typeof block.name === 'string') {
                        const input = 'input' in block ? JSON.stringify(block.input) : '';
                        toolSummaries.push(`${block.name}(${input.slice(0, 80)})`);
                    }
                }
            }
        }

        const summary = `[Context compressed — ${toolSummaries.length} earlier tool calls summarized: ${toolSummaries.join(', ')}. Their full results have been trimmed to save context. If you need this data again, re-query the relevant signals.]`;

        // Replace middle section with a single summarized user message
        msgs.splice(middleStart, middleEnd - middleStart, {
            role: 'user' as const,
            content: summary,
        });
    }
}