const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};

export function upgradeCommonSettings(value: unknown, base: unknown = {}) {
  const source = object(value), parent = object(base);
  const identity = { ...object(parent.identity), ...object(source.identity) };
  if(identity.kind!==undefined && identity.kind!=='chat' && identity.kind!=='request')throw new Error('旧設定の種類を確認してください。');
  const moderation = { ...object(parent.moderation), ...object(source.moderation) };
  const restricted = identity.kind === 'request' || identity.kind === undefined && identity.showId === false;
  const ownIdentity = { ...object(source.identity) }; delete ownIdentity.kind;
  const ownModeration = { ...object(source.moderation) };
  const parentIdentity=object(parent.identity),parentModeration=object(parent.moderation);
  const parentRestricted=parentModeration.allowChannelRestriction ?? (parentIdentity.kind === 'request' || parentIdentity.kind === undefined && parentIdentity.showId === false);
  const direct=moderation.allowDirectPosts ?? identity.showId === false;
  const parentDirect=parentModeration.allowDirectPosts ?? parentIdentity.showId === false;
  if(!Object.keys(parent).length || direct!==parentDirect)ownModeration.allowDirectPosts=direct;
  if(!Object.keys(parent).length || restricted!==parentRestricted)ownModeration.allowChannelRestriction=ownModeration.allowChannelRestriction ?? restricted;
  return { ...source, ...(source.identity ? { identity: ownIdentity } : {}), ...(Object.keys(ownModeration).length?{moderation:ownModeration}:{}) };
}
