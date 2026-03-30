import { AIProvider } from './types';
import { ClaudeProvider } from './claude';
import { OpenAIProvider } from './openai';
import { GeminiProvider } from './gemini';

export const PROVIDERS: AIProvider[] = [
  new ClaudeProvider(),
  new OpenAIProvider(),
  new GeminiProvider(),
];

export function getProvider(id: string): AIProvider {
  return PROVIDERS.find(p => p.id === id) || PROVIDERS[0];
}

export * from './types';
export * from './claude';
export * from './openai';
export * from './gemini';
