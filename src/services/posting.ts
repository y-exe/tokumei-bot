import { AttachmentBuilder, DiscordAPIError, HTTPError, WebhookClient, type TextChannel } from 'discord.js';
import type { Store, StoredPost } from '../infra/store.js';
import type { SecretBox } from '../infra/secrets.js';
import { UserError } from '../domain/errors.js';
import { postContent, validatePost, validateText, type PostInput } from '../domain/validation.js';
import { postCard } from '../ui/post.js';
import type { Config } from '../domain/config.js';
import { SerialQueue } from '../infra/serial.js';
import { nextAvatar } from '../domain/avatar.js';
import {isRequestMode} from '../domain/config.js';
import { deliveryError } from './delivery-error.js';

export class Posting {
  private queue = new SerialQueue(Number.POSITIVE_INFINITY);
  private volatile = new Map<string,{lastUser:string;users:Map<string,{anonymousId:number;avatar:number;at:number}>}>();
  private attempts = new Map<string,number>();
  sweep(): void {
    const cutoff=Date.now()-86_400_000;
    for(const [channel,state] of this.volatile){
      for(const [user,session] of state.users)if(session.at<cutoff)state.users.delete(user);
      if(!state.users.size)this.volatile.delete(channel);
    }
    for(const [operation,at] of this.attempts)if(at<Date.now()-600_000)this.attempts.delete(operation);
  }
  constructor(readonly store: Store, readonly secrets: SecretBox) {}
  async publish(input: PostInput): Promise<string> {
    return this.queue.run(`${input.guildId}:${input.channelId}`, input.media.reduce((sum, file) => sum + file.data.length, 0), () => this.publishLocked(input));
  }
  private async publishLocked(input: PostInput): Promise<string> {
    const settings = await this.store.settings(input.guildId, input.channelId, true);
    if (!settings.enabled || !settings.webhook) throw new UserError('このチャンネルには匿名投稿が設置されていません。');
    validatePost(input, settings.config);
    const reply=input.replyTo?await this.store.post(input.guildId,input.channelId,input.replyTo):null;
    if (input.replyTo && !reply) throw new UserError('返信先が削除済みか保存期限を過ぎています。');
    const linked=settings.config.policy.retentionDays===0?input.text:await this.linkReferences(input.text,input.guildId,input.channelId,new Date());
    const content = postContent(linked, input.source, input.replyTo, input.guildId, input.channelId,reply?.anonymous_id, input.videoLinks);
    if (content.length > 2000) throw new UserError('出典・返信リンクを含めて2000文字以内になるように本文を短くしてください。');
    if(settings.config.policy.retentionDays===0)return this.publishWithoutLog(input,settings.config,settings.webhook,content);
    const reserved = await this.store.reserve(input, settings.config, settings.webhook);
    const webhook = new WebhookClient({ url: this.secrets.open(settings.webhook) });
    let delivery: { messageId: string; media: StoredPost['media'] } | undefined;
    try {
      const sent = await webhook.send({ username: settings.config.identity.showId ? `匿名 ${String(reserved.anonymous_id).padStart(3, '0')}` : '匿名',
        avatarURL: `https://cdn.discordapp.com/embed/avatars/${reserved.avatar}.png`,
        content: content || undefined, allowedMentions: { parse: [] },
        files: input.media.map(file => new AttachmentBuilder(file.data, { name: file.name })),
      });
      delivery = { messageId: sent.id, media: sent.attachments.map((attachment, index) => ({ url: attachment.url, name: attachment.filename, kind: input.media[index]?.kind ?? 'image' })) };
      await this.store.markSent(input.operationId, delivery.messageId, delivery.media);
      return `https://discord.com/channels/${input.guildId}/${input.channelId}/${sent.id}`;
    } catch (error) {
      await this.store.markUncertain(input.operationId, delivery).catch(() => undefined);
      throw deliveryError(error, false);
    } finally { webhook.destroy(); }
  }
  async linkReferences(content:string,guildId:string,channelId:string,before:Date):Promise<string>{
    const pattern=/(?<![\[\\])>>([0-9]{1,4})(?![\]\d])/g;
    const numbers=[...new Set([...content.matchAll(pattern)].map(match=>Number(match[1])))];
    const targets=await this.store.anonymousReferences(guildId,channelId,numbers,before);
    return content.replace(pattern,(match,number:string)=>{const target=targets.get(Number(number));return target?`[${match}](https://discord.com/channels/${guildId}/${channelId}/${target})`:match;});
  }
  private async publishWithoutLog(input: PostInput, config: Config, credential: string, content: string): Promise<string> {
    const now=Date.now();
    for(const [operation,at] of this.attempts)if(at<now-600_000)this.attempts.delete(operation);
    if(this.attempts.has(input.operationId))throw new UserError('この投稿は処理済みです。再送は行いません。');
    const restriction=(await this.store.pool.query('SELECT 1 FROM v2_restrictions WHERE guild_id=$1 AND user_id=$2 AND (expires_at IS NULL OR expires_at>now())',[input.guildId,input.userId])).rows[0];
    if(restriction)throw new UserError('このサーバーでは匿名投稿の利用が制限されています。');
    if(isRequestMode(config)&&(await this.store.pool.query('SELECT 1 FROM v2_request_restrictions WHERE guild_id=$1 AND user_id=$2',[input.guildId,input.userId])).rowCount)throw new UserError('このサーバーでは匿名要望の使用権が剥奪されています。');
    const key=`${input.guildId}:${input.channelId}`;
    const state=this.volatile.get(key)??{lastUser:'',users:new Map()};
    for(const [user,session] of state.users)if(session.at<now-Math.max(config.policy.cooldown*1000,config.identity.minutes*60_000))state.users.delete(user);
    const previous=state.users.get(input.userId);const age=previous?now-previous.at:Infinity;
    if(age<config.policy.cooldown*1000)throw new UserError(`連続投稿は${Math.ceil(config.policy.cooldown-age/1000)}秒後にできます。`);
    const inherit=previous&&state.lastUser===input.userId&&age<config.identity.minutes*60_000;
    const persisted=(await this.store.pool.query(`INSERT INTO v2_counters(channel_id) VALUES($1)
      ON CONFLICT(channel_id) DO UPDATE SET counter=v2_counters.counter RETURNING counter,last_avatar`,[input.channelId])).rows[0];
    const anonymousId=inherit?previous.anonymousId:Number(persisted.counter)%1000+1;
    const avatar=inherit?previous.avatar:nextAvatar(persisted.last_avatar==null?undefined:Number(persisted.last_avatar));
    await this.store.pool.query('UPDATE v2_counters SET counter=$2,last_avatar=$3,last_user=NULL WHERE channel_id=$1',[input.channelId,anonymousId,avatar]);
    state.lastUser=input.userId;state.users.set(input.userId,{anonymousId,avatar,at:now});this.volatile.set(key,state);
    this.attempts.set(input.operationId,now);
    const webhook=new WebhookClient({url:this.secrets.open(credential)});
    try{
      const sent=await webhook.send({username:config.identity.showId?`匿名 ${String(anonymousId).padStart(3,'0')}`:'匿名',avatarURL:`https://cdn.discordapp.com/embed/avatars/${avatar}.png`,content:content||undefined,allowedMentions:{parse:[]},files:input.media.map(file=>new AttachmentBuilder(file.data,{name:file.name}))});
      return `https://discord.com/channels/${input.guildId}/${input.channelId}/${sent.id}`;
    }catch(error){throw deliveryError(error, true);}
    finally{webhook.destroy();}
  }
  async reconcile(guildId: string, channelId: string, userId: string, operationId: string): Promise<string> {
    const post = await this.store.ownOperation(guildId, channelId, userId, operationId);
    if (!post) throw new UserError('自分の保存期間内の投稿だけを確認できます。');
    if (!post.message_id) throw new UserError('Discordから投稿番号を受け取れていないため、自動確認できません。チャンネルに投稿が届いているか確認してください。再送は行いません。');
    const link = `https://discord.com/channels/${guildId}/${channelId}/${post.message_id}`;
    if (post.status === 'sent') return link;
    if (!post.delivery_webhook) throw new UserError('送信時の情報が不足しているため、自動確認できません。チャンネルを確認してください。');
    const webhook = new WebhookClient({ url: this.secrets.open(post.delivery_webhook) });
    try {
      const message = await webhook.fetchMessage(post.message_id);
      if (message.channel_id !== channelId || message.webhook_id !== webhook.id) throw new UserError('送信先を確認できませんでした。再送は行いません。');
      await this.store.markSent(operationId, post.message_id, message.attachments.map(attachment => ({
        url: attachment.url, name: attachment.filename,
        kind: post.media.find(file => file.name === attachment.filename)?.kind ?? 'image',
      })));
      return link;
    } finally { webhook.destroy(); }
  }
  async own(guildId: string, channelId: string, messageId: string, userId: string): Promise<StoredPost> {
    const post = await this.store.post(guildId, channelId, messageId);
    if (!post) throw new UserError('投稿が削除済みか、本人確認の保存期限を過ぎています。');
    if (post.user_id !== userId) throw new UserError('自分の投稿だけを操作できます。');
    if (post.layout === 'legacy' && !post.content && !post.media.length && post.legacy_webhook) {
      const webhook = new WebhookClient({ url: this.secrets.open(post.legacy_webhook) });
      try {
        const message = await webhook.fetchMessage(messageId);
        post.content = message.content;
        post.media = message.attachments.map(attachment => ({ url: attachment.url, name: attachment.filename, kind: attachment.content_type?.startsWith('video/') ? 'video' : 'image' }));
        await this.store.hydratePost(guildId, channelId, messageId, post.content, post.media);
      } finally { webhook.destroy(); }
    }
    return post;
  }
  async edit(guildId: string, channelId: string, messageId: string, userId: string, content: string): Promise<void> {
    const post = await this.own(guildId, channelId, messageId, userId);
    const settings = await this.store.settings(guildId, channelId, true);
    this.validateEdit(post, content, settings.config);
    const credential = post.legacy_webhook ?? post.delivery_webhook ?? settings.webhook;
    if (!credential) throw new UserError('投稿用Webhookが見つかりません。管理者に連絡してください。');
    const webhook = new WebhookClient({ url: this.secrets.open(credential) });
    try {
      const message = await webhook.fetchMessage(messageId);
      const linked=settings.config.policy.retentionDays===0?content:await this.linkReferences(content,guildId,channelId,post.created_at);
      const reply=post.reply_to?await this.store.post(guildId,channelId,post.reply_to):null;
      const previousNumber=message.content?.match(/^\[>>(\d{1,4})\]/)?.[1];
      const rendered = post.layout === 'legacy' ? linked : postContent(linked, post.source ?? undefined, post.reply_to ?? undefined, guildId, channelId,reply?.anonymous_id??(previousNumber?Number(previousNumber):undefined), post.videoLinks);
      if (post.layout !== 'v2' && rendered.length > 2000) throw new UserError('出典・返信リンクを含めて2000文字以内にしてください。');
      await webhook.editMessage(messageId, post.layout !== 'v2' ? { content: rendered,
        allowedMentions: { parse: [] } } : { components: [postCard(rendered, post.media, settings.config.panel.color)],
        withComponents: true, attachments: message.attachments.map(attachment => ({ id: attachment.id, filename: attachment.filename })), allowedMentions: { parse: [] } });
      await this.store.updatePost(guildId, channelId, messageId, content);
    } finally { webhook.destroy(); }
  }
  validateEdit(post: StoredPost, content: string, config: Config): void {
    validateText(content, config, post.layout === 'legacy' ? 2000 : 1800);
    if (post.source) validateText(post.source, config);
    if (!content.trim() && !post.media.length) throw new UserError('本文を空にすることはできません。投稿を削除してください。');
    if (!config.content.text && !post.media.length) throw new UserError('このチャンネルは画像必須です。');
    if (post.media.length && !config.content.caption && content.trim()) throw new UserError('このチャンネルでは説明文を付けられません。');
  }
  async remove(guildId: string, channelId: string, messageId: string, userId?: string): Promise<void> {
    const post = userId ? await this.own(guildId, channelId, messageId, userId) : await this.store.post(guildId, channelId, messageId);
    if (!post) throw new UserError('このBotの保存期間内の投稿だけを削除できます。');
    const settings = await this.store.settings(guildId, channelId, true);
    const credential = post.legacy_webhook ?? post.delivery_webhook ?? settings.webhook;
    if (!credential) throw new UserError('投稿用Webhookが見つかりません。');
    const webhook = new WebhookClient({ url: this.secrets.open(credential) });
    try { await webhook.deleteMessage(messageId); await this.store.deletePost(guildId, channelId, messageId); }
    finally { webhook.destroy(); }
  }
  async createWebhook(channel: TextChannel): Promise<string> {
    const settings = await this.store.settings(channel.guild.id, channel.id, true);
    if (settings.webhook) {
      const existing = new WebhookClient({ url: this.secrets.open(settings.webhook) });
      try {
        const webhook = await channel.client.fetchWebhook(existing.id, existing.token);
        if (webhook.channelId !== channel.id) throw new UserError('投稿用Webhookの送信先が一致しません。管理者に設定を確認してもらってください。');
        return settings.webhook;
      } catch (error) {
        if (!(error instanceof DiscordAPIError && (error.code === 10015 || error.code === 50027)) &&
            !((error instanceof DiscordAPIError || error instanceof HTTPError) && error.status === 401)) throw error;
      } finally { existing.destroy(); }
    }
    const webhook = await channel.createWebhook({ name: '匿名投稿', reason: '匿名Botの初期設定' });
    if (!webhook.url) throw new UserError('Webhookを作成できませんでした。');
    return this.secrets.seal(webhook.url);
  }
}
