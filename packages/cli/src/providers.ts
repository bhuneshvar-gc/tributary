import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

interface ProviderOptions {
  apiKey?: string;
  baseURL?: string;
}

export interface ProviderSpec {
  /** Used when ai.model isn't set; absent means the user must choose one. */
  defaultModel?: string;
  /** Whether ai.baseUrl must be set (a self-hosted endpoint has no sensible default). */
  needsBaseUrl?: boolean;
  create(model: string, options: ProviderOptions): LanguageModel;
}

/** Types an entry as ProviderSpec, so declarations don't leak each SDK's model class. */
const provider = (spec: ProviderSpec): ProviderSpec => spec;

/**
 * Every supported AI provider, in one place: adding one is one entry.
 * API keys fall back to each provider's usual environment variable
 * (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...).
 */
export const PROVIDERS = {
  anthropic: provider({
    defaultModel: "claude-sonnet-5-5",
    create: (m, o) => createAnthropic(o)(m),
  }),
  openai: provider({ defaultModel: "gpt-4o", create: (m, o) => createOpenAI(o)(m) }),
  google: provider({
    defaultModel: "gemini-2.0-flash",
    create: (m, o) => createGoogleGenerativeAI(o)(m),
  }),
  openrouter: provider({
    create: (m, o) =>
      createOpenRouter({
        ...o,
        headers: {
          "HTTP-Referer": "https://github.com/bhuneshvar-k/tributary",
          "X-Title": "Tributary",
        },
      })(m),
  }),
  opencode: provider({
    needsBaseUrl: true,
    create: (m, o) =>
      createOpenAICompatible({
        name: "opencode",
        baseURL: o.baseURL!,
        ...(o.apiKey && { apiKey: o.apiKey }),
      })(m),
  }),
};

export type AiProvider = keyof typeof PROVIDERS;
export const AI_PROVIDERS = Object.keys(PROVIDERS) as AiProvider[];
