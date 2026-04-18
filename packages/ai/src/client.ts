import Anthropic from '@anthropic-ai/sdk';

export interface AIConfig {
  apiKey: string;
  model: string;
}

export function createAnthropic(config: AIConfig): Anthropic {
  return new Anthropic({ apiKey: config.apiKey });
}

export { Anthropic };
