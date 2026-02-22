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
}
