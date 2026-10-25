import type { Config } from './config.js';

export interface FloodEvent { at: number; chars: number; hash: string; operationId: string; channelId: string; }
export interface FloodState { events: FloodEvent[]; blockedUntil: number; }
export function floodDecision(state: FloodState, input: Omit<FloodEvent, 'at'>, policy: Config['policy'], now: number, consume: boolean): { state: FloodState; denied: boolean; cooldown?: number } {
  const events = state.events.filter(event => event.at > now - Math.max(300_000, policy.duplicateSeconds * 1000, policy.cooldown * 1000));
  const next = { events, blockedUntil: state.blockedUntil > now ? state.blockedUntil : 0 };
  if (next.blockedUntil) return { state: next, denied: true };
  if (events.some(event => event.operationId === input.operationId)) return { state: next, denied: false };
  const previous = events.filter(event => event.channelId === input.channelId).at(-1);
  if (previous && now - previous.at < policy.cooldown * 1000)
    return { state: next, denied: true, cooldown: Math.ceil(policy.cooldown - (now - previous.at) / 1000) };
  const { chars, hash } = input;
  const minute = events.filter(event => event.at > now - 60_000);
  const fiveMinutes = events.filter(event => event.at > now - 300_000);
  if ((policy.charsPerMinute > 0 && minute.reduce((sum, event) => sum + event.chars, chars) > policy.charsPerMinute)
    || (policy.charsPerFiveMinutes > 0 && fiveMinutes.reduce((sum, event) => sum + event.chars, chars) > policy.charsPerFiveMinutes)) {
    next.blockedUntil = now + policy.spamTimeoutMinutes * 60_000;
    next.events = events.filter(event => event.at + Math.max(300_000, policy.duplicateSeconds * 1000, policy.cooldown * 1000) > next.blockedUntil);
    return { state: next, denied: true };
  }
  if (policy.postsPerMinute > 0 && minute.length >= policy.postsPerMinute) return { state: next, denied: true };
  if (hash && policy.duplicateSeconds > 0 && events.some(event => event.hash === hash && event.at > now - policy.duplicateSeconds * 1000))
    return { state: next, denied: true };
  if (consume) events.push({ at: now, chars, hash, operationId: input.operationId, channelId: input.channelId });
  return { state: next, denied: false };
}
