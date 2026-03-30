import { ClaudeProvider } from './claude';
import { GeminiProvider } from './gemini';
import { OpenAIProvider } from './openai';
import { ShellProvider } from './shell';
import { AIProvider } from './types';

export const PROVIDERS: AIProvider[] = [
  new ClaudeProvider(),
  new OpenAIProvider(),
  new GeminiProvider(),
  new ShellProvider(),
];

export function getProvider(id: string): AIProvider {
  return PROVIDERS.find(p => p.id === id) || PROVIDERS[0];
}

export * from './claude';
export * from './gemini';
export * from './openai';
export * from './shell';
export * from './types';
