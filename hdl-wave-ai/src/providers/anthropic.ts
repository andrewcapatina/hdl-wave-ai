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
import { LLMMessage, LLMProvider } from './llm';

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
}