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
}
