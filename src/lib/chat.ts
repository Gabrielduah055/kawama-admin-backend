export const CHAT_MESSAGE_MAX_LENGTH = 2_000;
export const CHAT_STORED_MESSAGE_LIMIT = 12;
export const CHAT_MORE_INFORMATION_NOTICE = 'More recorded information is available. Ask me for the remaining details.';

export interface ComposedChatResponse {
  content: string;
  omittedSections: boolean;
}

export function descriptionSections(description: string): string[] {
  return description
    .split(/(?<=[.!?])\s+|\r?\n+/)
    .map((section) => section.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .slice(0, 40);
}

export function composeChatResponse(sections: string[]): ComposedChatResponse {
  const normalized = sections.map((section) => section.trim()).filter(Boolean);
  const complete = normalized.join(' ');
  if (complete.length <= CHAT_MESSAGE_MAX_LENGTH) {
    return { content: complete, omittedSections: false };
  }

  const selected: string[] = [];
  const availableLength = CHAT_MESSAGE_MAX_LENGTH - CHAT_MORE_INFORMATION_NOTICE.length - 1;
  for (const section of normalized) {
    const candidateLength = selected.reduce((length, item) => length + item.length, 0)
      + Math.max(0, selected.length)
      + section.length;
    if (candidateLength <= availableLength) selected.push(section);
  }
  return {
    content: [...selected, CHAT_MORE_INFORMATION_NOTICE].join(' '),
    omittedSections: true,
  };
}

export function isValidStoredChatMessage(content: string): boolean {
  return content.length > 0 && content.length <= CHAT_MESSAGE_MAX_LENGTH;
}
