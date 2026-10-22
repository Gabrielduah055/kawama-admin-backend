import type { RequestHandler } from 'express';
import type { ChatProvider } from '../services/openrouter.service.js';
import { runShoppingChat } from '../services/chat.service.js';
import { chatRequestSchema, chatSessionTokenSchema } from '../validation/chat.schemas.js';

export function createChatHandler(provider: ChatProvider): RequestHandler {
  return async (request, response) => {
    const input = chatRequestSchema.parse(request.body);
    const suppliedSessionToken = request.header('x-chat-session');
    const sessionToken = suppliedSessionToken === undefined
      ? undefined
      : chatSessionTokenSchema.parse(suppliedSessionToken);
    const result = await runShoppingChat(input, sessionToken, provider);
    response.setHeader('X-Chat-Session', result.sessionToken);
    response.setHeader('Cache-Control', 'no-store');
    response.status(200).json({
      message: 'Assistant response generated successfully',
      data: {
        conversationId: result.conversationId,
        assistantMessage: result.assistantMessage,
        products: result.products,
        ...(result.suggestedFollowUps.length > 0
          ? { suggestedFollowUps: result.suggestedFollowUps }
          : {}),
      },
    });
  };
}
