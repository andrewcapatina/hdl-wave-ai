import * as vscode from 'vscode';
import { LLMProvider } from './llm';
import { AnthropicClient } from './anthropic';
import { OpenAICompatibleClient } from './openaiCompatible';

export function createProvider(): LLMProvider {
    const config = vscode.workspace.getConfiguration('hdlWaveAi');
    const providerType = config.get<string>('provider', 'anthropic');

    if (providerType === 'anthropic') {
        const apiKey = config.get<string>('anthropic.apiKey', '');
        const model = config.get<string>('anthropic.model', 'claude-sonnet-4-6');
        if (!apiKey) {
            throw new Error('Anthropic API key is not set. Configure hdlWaveAi.anthropic.apiKey in settings.');
        }
        return new AnthropicClient(apiKey, model);
    }

    if (providerType === 'openai-compatible') {
        const baseUrl = config.get<string>('openaiCompatible.baseUrl', 'http://localhost:11434/v1');
        const apiKey = config.get<string>('openaiCompatible.apiKey', 'ollama');
        const model = config.get<string>('openaiCompatible.model', 'qwen2.5-coder:32b');
        return new OpenAICompatibleClient(baseUrl, apiKey, model);
    }

    throw new Error(`Unknown provider: ${providerType}`);
}
