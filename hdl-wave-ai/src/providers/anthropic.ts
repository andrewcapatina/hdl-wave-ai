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

    constructor(apiKey: string, model: string) {
        this.client = new Anthropic({ apiKey });
        this.model = model;
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

        for (let round = 0; round < 10; round++) {
            if (signal?.aborted) { return ''; }

            // Force tool use on first round so the model queries actual data.
            const toolChoice: Anthropic.MessageCreateParams['tool_choice'] =
                round === 0 ? { type: 'any' } : { type: 'auto' };

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

            const toolResults: Anthropic.ToolResultBlockParam[] = toolUseBlocks.map(b => ({
                type: 'tool_result' as const,
                tool_use_id: b.id,
                content: toolExecutor(b.name, b.input as Record<string, unknown>),
            }));
            msgs.push({ role: 'user', content: toolResults });
        }
        return 'Tool loop exceeded maximum rounds without a final answer.';
    }
}