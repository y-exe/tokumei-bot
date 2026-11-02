import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { Store } from '../src/infra/store.js';
import { SecretBox } from '../src/infra/secrets.js';
import { defaults, importTemplate } from '../src/domain/config.js';

test('旧専用モード・停止対象・設定履歴を共通設定へ移行し、元のチャンネルだけ制限する',async()=>{
  const db=await PGlite.create();const server=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:5});await server.start();
  const url=`postgresql://postgres:postgres@${server.getServerConn()}/postgres`;
  let store=new Store(url);
  try{
    await store.initialize();
    const base:any=structuredClone(defaults);base.identity.kind='chat';delete base.moderation.allowChannelRestriction;
    await store.pool.query('INSERT INTO v2_guilds(guild_id,config) VALUES($1,$2)',['g',base]);
    const legacy={identity:{kind:'request',showId:false},moderation:{allowDirectPosts:true},content:{caption:false}};
    for(const [channel,value] of [['source',legacy],['normal',{}],['hidden',{identity:{kind:'chat',showId:false}}]]){
      await store.pool.query('INSERT INTO v2_channels(guild_id,channel_id,overrides,enabled) VALUES($1,$2,$3,true)',['g',channel,value]);
    }
    await store.pool.query('CREATE TABLE v2_request_restrictions(guild_id text,user_id text,reason text,created_at timestamptz DEFAULT now())');
    await store.pool.query("INSERT INTO v2_request_restrictions(guild_id,user_id,reason) VALUES('g','300000000000000001','保存中の制限')");
    await store.pool.query('INSERT INTO v2_revisions(guild_id,channel_id,config,actor_id) VALUES($1,$2,$3,$4)',['g','source',legacy,'400000000000000001']);
    await store.pool.query("DELETE FROM v2_migrations WHERE name='common-settings-v1'");
    await store.close();store=new Store(url,new SecretBox(randomBytes(32).toString('base64')));await store.initialize();
    const config=(await store.settings('g','source')).config;
    assert.equal(config.identity.showId,false);assert.equal(config.content.caption,false);
    assert.equal(config.moderation.allowDirectPosts,true);assert.equal(config.moderation.allowChannelRestriction,true);
    assert.ok(!('kind' in config.identity));
    assert.equal((await store.settings('g','normal')).config.moderation.allowChannelRestriction,false);
    assert.equal((await store.settings('g','hidden')).config.moderation.allowChannelRestriction,false);
    assert.equal((await store.pool.query("SELECT to_regclass('public.v2_request_restrictions') AS table_name")).rows[0].table_name,null);
    const rows=(await store.pool.query('SELECT channel_id,user_id FROM v2_channel_restrictions')).rows;
    assert.equal(rows.length,1);assert.equal(rows[0].channel_id,'source');assert.match(rows[0].user_id,/^h1:/);
    await assert.rejects(store.checkRestrictions('g','300000000000000001','source'),/停止/);
    await store.checkRestrictions('g','300000000000000001','normal');
    const backup=(await store.settingsBackups('g'))[0]!;
    const restored=await store.settingsBackup('g','source',backup.id);
    assert.equal(restored?.moderation?.allowChannelRestriction,true);assert.ok(!('kind' in restored!.identity!));
    const imported=importTemplate({version:1,settings:legacy},defaults);
    assert.equal(imported.moderation?.allowChannelRestriction,true);assert.ok(!('kind' in imported.identity!));
    const version=(await store.settings('g','source')).channelVersion;
    await store.initialize();assert.equal((await store.settings('g','source')).channelVersion,version);
    await store.releaseChannelRestriction('g','source','300000000000000001','400000000000000001');
    await store.checkRestrictions('g','300000000000000001','source');
  }finally{await store.close();await server.stop();await db.close();}
});
