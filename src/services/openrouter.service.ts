import { z } from 'zod';
import { DEFAULT_OPENROUTER_MODEL, getEnvironment } from '../config/environment.js';
import { AppError } from '../errors/AppError.js';

export { DEFAULT_OPENROUTER_MODEL };
const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

export interface ProviderToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ProviderToolCall[] | undefined;
  tool_call_id?: string | undefined;
  name?: string | undefined;
}

export interface ProviderToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionRequest {
  messages: ProviderMessage[];
  tools: ProviderToolDefinition[];
  maxTokens: number;
}

export interface ChatProvider {
  complete(input: ChatCompletionRequest): Promise<ProviderMessage>;
}

const providerToolCallSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1).max(100),
    arguments: z.string().max(10_000),
  }),
});

const providerResponseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      role: z.literal('assistant'),
      content: z.string().nullable().optional(),
      tool_calls: z.array(providerToolCallSchema).max(12).optional(),
    }),
  })).min(1),
});

function unavailable(code: string, message: string, status = 503): AppError {
  return new AppError(status, code, message);
}

export function createOpenRouterProvider(fetchImpl: typeof fetch = fetch): ChatProvider {
  return {
    async complete(input) {
      const environment = getEnvironment();
      if (!environment.AI_CHAT_ENABLED) {
        throw unavailable('AI_CHAT_DISABLED', 'The shopping assistant is currently disabled.');
      }
      if (!environment.OPENROUTER_API_KEY) {
        throw unavailable('AI_CHAT_NOT_CONFIGURED', 'The shopping assistant is temporarily unavailable.');
      }
      const body = JSON.stringify({
        model: environment.OPENROUTER_MODEL,
        messages: input.messages,
        tools: input.tools,
        tool_choice: 'auto',
        parallel_tool_calls: false,
        reasoning: { effort: 'low' },
        temperature: 0.2,
        max_tokens: input.maxTokens,
      });

      let lastNetworkError: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let response: Response;
        try {
          response = await fetchImpl(OPENROUTER_CHAT_URL, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${environment.OPENROUTER_API_KEY}`,
              'Content-Type': 'application/json',
              'X-Title': 'Kawama Shopping Assistant',
            },
            body,
            signal: AbortSignal.timeout(environment.OPENROUTER_TIMEOUT_MS),
          });
        } catch (error) {
          lastNetworkError = error;
          if (attempt === 0) continue;
          const timedOut = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
          throw unavailable(
            timedOut ? 'AI_PROVIDER_TIMEOUT' : 'AI_PROVIDER_UNAVAILABLE',
            'The shopping assistant is taking a break. Please try again shortly.',
            timedOut ? 504 : 503,
          );
        }

        if (response.status === 429) {
          throw unavailable('AI_PROVIDER_RATE_LIMITED', 'The shopping assistant is busy. Please try again shortly.');
        }
        if (response.status >= 500) {
          if (attempt === 0) continue;
          throw unavailable('AI_PROVIDER_UNAVAILABLE', 'The shopping assistant is taking a break. Please try again shortly.');
        }
        if (!response.ok) {
          throw unavailable('AI_PROVIDER_REJECTED', 'The shopping assistant is temporarily unavailable.', 502);
        }

        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          throw unavailable('AI_PROVIDER_INVALID_RESPONSE', 'The shopping assistant returned an invalid response.', 502);
        }
        const parsed = providerResponseSchema.safeParse(payload);
        if (!parsed.success) {
          throw unavailable('AI_PROVIDER_INVALID_RESPONSE', 'The shopping assistant returned an invalid response.', 502);
        }
        const message = parsed.data.choices[0]!.message;
        const content = message.content ?? null;
        const toolCalls = message.tool_calls;
        if ((!content || content.trim().length === 0) && (!toolCalls || toolCalls.length === 0)) {
          throw unavailable('AI_PROVIDER_EMPTY_RESPONSE', 'The shopping assistant returned an empty response.', 502);
        }
        return {
          role: 'assistant',
          content,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        };
      }
      throw unavailable(
        'AI_PROVIDER_UNAVAILABLE',
        'The shopping assistant is taking a break. Please try again shortly.',
        lastNetworkError ? 503 : 502,
      );
    },
  };
}

export const openRouterProvider = createOpenRouterProvider();
