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
import { LLMMessage, LLMProvider } from './llm';

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
}