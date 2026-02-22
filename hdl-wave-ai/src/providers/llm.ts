export interface LLMMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

export interface LLMProvider {
    chat(messages: LLMMessage[]): Promise<string>;
}
