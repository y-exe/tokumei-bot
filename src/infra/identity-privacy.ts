import type { PoolClient } from 'pg';
import type { SecretBox } from './secrets.js';

export class IdentityPrivacy {
  constructor(private box: SecretBox) {}
  key(guildId: string, userId: string): string {
    return userId.startsWith('h1:') ? userId : `h1:${this.box.fingerprint('identity', guildId, userId)}`;
  }
  seal(userId: string): string { return this.box.seal(userId); }
  open(userId: string, ciphertext?: string | null): string {
    if (ciphertext) return this.box.open(ciphertext);
    if (userId.startsWith('h1:')) throw new Error('投稿者情報の暗号文が見つかりません。');
    return userId;
  }
  async migrate(client: PoolClient): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('v2-identity-privacy'))");
    const tag = this.box.fingerprint('identity-key', 'v1');
    await client.query("INSERT INTO v2_identity_keys(name,key_tag) VALUES('v1',$1) ON CONFLICT DO NOTHING", [tag]);
    if ((await client.query("SELECT key_tag FROM v2_identity_keys WHERE name='v1'")).rows[0].key_tag !== tag)
      throw new Error('ID保護に使用した暗号鍵が一致しません。既存の暗号鍵を確認してください。');
    const denials = (await client.query("SELECT message_key FROM v2_legacy_lookup_denials WHERE message_key NOT LIKE 'h1:%' FOR UPDATE")).rows;
    for (const row of denials) {
      await client.query('INSERT INTO v2_legacy_lookup_denials(message_key) VALUES($1) ON CONFLICT DO NOTHING', [this.key('legacy-lookup-message', row.message_key)]);
      await client.query('DELETE FROM v2_legacy_lookup_denials WHERE message_key=$1', [row.message_key]);
    }
    const authors = (await client.query(`SELECT a.operation_id,a.user_id,p.guild_id FROM v2_authors a
      JOIN v2_posts p USING(operation_id) WHERE a.user_id NOT LIKE 'h1:%' FOR UPDATE OF a`)).rows;
    for (const row of authors) await client.query('UPDATE v2_authors SET user_id=$2,user_ciphertext=$3 WHERE operation_id=$1',
      [row.operation_id, this.key(row.guild_id, row.user_id), this.seal(row.user_id)]);
    for (const table of ['v2_sessions', 'v2_restrictions', 'v2_request_restrictions']) {
      const rows = (await client.query(`SELECT guild_id,user_id FROM ${table} WHERE user_id NOT LIKE 'h1:%' FOR UPDATE`)).rows;
      for (const row of rows) await client.query(`UPDATE ${table} SET user_id=$3 WHERE guild_id=$1 AND user_id=$2`, [row.guild_id, row.user_id, this.key(row.guild_id, row.user_id)]);
    }
    const counters = (await client.query(`SELECT c.channel_id,c.last_user,ch.guild_id FROM v2_counters c
      JOIN v2_channels ch USING(channel_id) WHERE c.last_user IS NOT NULL AND c.last_user NOT LIKE 'h1:%' FOR UPDATE OF c`)).rows;
    for (const row of counters) await client.query('UPDATE v2_counters SET last_user=$2 WHERE channel_id=$1', [row.channel_id, this.key(row.guild_id, row.last_user)]);
    for (const table of ['v2_actions', 'v2_revisions']) {
      const rows = (await client.query(`SELECT id,guild_id,actor_id FROM ${table} WHERE actor_id NOT LIKE 'h1:%' FOR UPDATE`)).rows;
      for (const row of rows) await client.query(`UPDATE ${table} SET actor_id=$2 WHERE id=$1`, [row.id, this.key(row.guild_id, row.actor_id)]);
    }
    const reports = (await client.query("SELECT id,guild_id,reporter_id,evidence FROM v2_reports WHERE reporter_id NOT LIKE 'h1:%' OR evidence ? 'userId' FOR UPDATE")).rows;
    for (const row of reports) {
      const evidence = { ...row.evidence };
      if (evidence.userId) evidence.userCiphertext = this.seal(evidence.userId);
      delete evidence.userId;
      if (!row.reporter_id.startsWith('h1:')) await client.query('UPDATE v2_reports SET reporter_id=$2,reporter_ciphertext=$3 WHERE id=$1',
        [row.id, this.key(row.guild_id, row.reporter_id), this.seal(row.reporter_id)]);
      await client.query('UPDATE v2_reports SET evidence=$2 WHERE id=$1', [row.id, JSON.stringify(evidence)]);
    }
  }
}
