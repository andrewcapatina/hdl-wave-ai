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
import { LLMMessage, LLMProvider, ToolDefinition } from './llm';

export class OpenAICompatibleClient implements LLMProvider {
    private client: OpenAI;
    private model: string;

    constructor(baseURL: string, apiKey: string, model: string) {
        this.client = new OpenAI({ baseURL, apiKey: apiKey || 'ollama' });
        this.model = model;
    }

    async chat(messages: LLMMessage[]): Promise<string> {
        const response = await this.client.chat.completions.create({
            model: this.model,
            messages: messages.map(m => ({ role: m.role, content: m.content })),
        });

        return response.choices[0]?.message?.content ?? '';
    }

    async *stream(messages: LLMMessage[], signal?: AbortSignal): AsyncGenerator<string> {
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

    async chatWithTools(
        messages: LLMMessage[],
        tools: ToolDefinition[],
        toolExecutor: (name: string, args: Record<string, unknown>) => string,
        signal?: AbortSignal
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

        // Pre-query top signals in the user's time range so the model has
        // real data even if it can't construct correct tool-call parameters.
        const userMsg = [...messages].reverse().find(m => m.role === 'user');
        const rangeMatch = userMsg?.content.match(/t_start=(\d+)[\s\S]*?t_end=(\d+)/);
        if (rangeMatch) {
            const tStart = Number(rangeMatch[1]);
            const tEnd = Number(rangeMatch[2]);
            try {
                const signals: { name: string; transitionCount: number }[] = JSON.parse(listResult);
                const topSignals = signals
                    .sort((a, b) => b.transitionCount - a.transitionCount)
                    .slice(0, 10);

                const toolCalls: OpenAI.ChatCompletionMessageToolCall[] = [];
                const toolResults: OpenAI.ChatCompletionToolMessageParam[] = [];

                for (let i = 0; i < topSignals.length; i++) {
                    const sig = topSignals[i];
                    const callId = `preseed_query_${i}`;
                    const args = { signal: sig.name, t_start: tStart, t_end: tEnd };
                    const result = toolExecutor('query_transitions', args);
                    toolCalls.push({
                        id: callId,
                        type: 'function',
                        function: { name: 'query_transitions', arguments: JSON.stringify(args) },
                    });
                    toolResults.push({ role: 'tool', tool_call_id: callId, content: result });
                }

                if (toolCalls.length > 0) {
                    msgs.push({
                        role: 'assistant',
                        content: null,
                        tool_calls: toolCalls,
                    });
                    msgs.push(...toolResults);
                }
            } catch { /* ignore parse errors */ }
        }

        for (let round = 0; round < 10; round++) {
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
                const content = message.content ?? '';
                // Small models (Ollama) sometimes return tool-call JSON as text
                // instead of a natural language analysis. Detect this and re-prompt
                // without tools to force a proper text response.
                if (!content.trim() || (content.includes('"name"') && content.includes('"arguments"'))) {
                    const retry = await this.client.chat.completions.create({
                        model: this.model,
                        messages: [...msgs, {
                            role: 'user' as const,
                            content: 'Based on all the waveform data above, provide your analysis in plain text. Do not output JSON or tool calls.',
                        }],
                    }, { signal });
                    return retry.choices[0]?.message?.content ?? content;
                }
                return content;
            }

            for (const tc of message.tool_calls) {
                let args: Record<string, unknown> = {};
                try { args = JSON.parse(tc.function.arguments); } catch { /* ignore */ }
                const result = toolExecutor(tc.function.name, args);
                msgs.push({ role: 'tool', tool_call_id: tc.id, content: result });
            }
        }
        return 'Tool loop exceeded maximum rounds without a final answer.';
    }
}