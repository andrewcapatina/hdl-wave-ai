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
