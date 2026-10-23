export const fallbackEmoji = {
  check: '✅', flag: '🚩', warning: '⚠️', info: 'ℹ️', error: '❌',
  time: '🕒', content: '📝', count: '🔢', reporter: '👤',
} as const;
export type EmojiKey = keyof typeof fallbackEmoji;
export const uiEmoji: Record<EmojiKey, string> = { ...fallbackEmoji };
export const emojiDefinitions: Record<EmojiKey, { name: string; legacyName: string }> = {
  check: { name: 'tm_check', legacyName: 'legacy_9' },
  flag: { name: 'tm_flag', legacyName: 'legacy_3' },
  warning: { name: 'tm_warning', legacyName: 'legacy_11' },
  info: { name: 'tm_info', legacyName: 'legacy_10' },
  error: { name: 'tm_error', legacyName: '12' },
  time: { name: 'tm_time', legacyName: 'legacy_6' },
  content: { name: 'tm_content', legacyName: 'legacy_5' },
  count: { name: 'tm_count', legacyName: 'legacy_8' },
  reporter: { name: 'tm_reporter', legacyName: 'legacy_7' },
};
