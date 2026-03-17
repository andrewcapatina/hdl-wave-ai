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
import { LLMMessage, LLMProvider, ToolDefinition } from './llm';

export class AnthropicClient implements LLMProvider {
    private client: Anthropic;
    private model: string;
    private maxToolRounds: number;

    constructor(apiKey: string, model: string, maxToolRounds = 0, maxPromptTokens = 200000) {
        this.client = new Anthropic({ apiKey });
        this.model = model;
        this.maxToolRounds = maxToolRounds > 0
            ? maxToolRounds
            : Math.max(5, Math.min(30, Math.floor(maxPromptTokens / 2000)));
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
        signal?: AbortSignal
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

            if (!toolUseBlocks.length || response.stop_reason === 'end_turn') {
                const textBlock = response.content.find(b => b.type === 'text');
                return textBlock?.type === 'text' ? textBlock.text : '';
            }

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

            // Inject a progress nudge so the model knows where it stands.
            const progressHint = this.buildProgressHint(totalToolCalls, queriedSignals, round, this.maxToolRounds);
            if (progressHint) {
                toolResults.push({
                    type: 'tool_result' as const,
                    tool_use_id: toolUseBlocks[toolUseBlocks.length - 1].id,
                    content: toolResults[toolResults.length - 1].content + '\n\n' + progressHint,
                });
                // Replace the last result with the augmented one
                toolResults.splice(-2, 1);
            }

            msgs.push({ role: 'user', content: toolResults });

            // Compress old tool results if context is growing too large.
            // Keep the first user message and last 4 message pairs intact;
            // summarize everything in between.
            this.compressToolHistory(msgs);
        }
        return 'Tool loop exceeded maximum rounds without a final answer.';
    }

    /**
     * Build a progress hint to inject after tool results, nudging the model
     * to keep investigating if it hasn't gathered enough data yet.
     */
    private buildProgressHint(
        totalCalls: number,
        queriedSignals: Set<string>,
        currentRound: number,
        maxRounds: number,
    ): string | null {
        if (totalCalls >= 15) { return null; } // enough calls, let the model decide

        const signalList = [...queriedSignals].join(', ');
        const remaining = maxRounds - currentRound - 1;
        const parts: string[] = [];

        parts.push(`[Progress: ${totalCalls} tool call(s) so far, ${remaining} rounds remaining.]`);

        if (queriedSignals.size > 0) {
            parts.push(`Signals queried so far: ${signalList}.`);
        }

        if (totalCalls < 5) {
            parts.push('You should make more tool calls before writing your analysis. Consider: snapshot() at key timestamps, query_transitions() on control signals (HLT, FLUSH, XDREQ), or decode_instruction() on fetched instruction values.');
        }

        return parts.join(' ');
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