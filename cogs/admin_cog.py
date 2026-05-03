import discord
from datetime import datetime, timedelta
from discord.ext import commands
from discord import app_commands
from models.constants import *
from utils.json_helper import load_json, save_json
from core.anonymous_logic import update_button_message, is_authorized
from ui.views import AnonymousPostView

class AdminCog(commands.Cog):
    def __init__(self, bot, anonymous_channels_data, banned_users, button_update_locks):
        self.bot = bot
        self.anonymous_channels_data = anonymous_channels_data
        self.banned_users = banned_users
        self.button_update_locks = button_update_locks

    @commands.Cog.listener()
    async def on_command_error(self, ctx, error):
        if isinstance(error, commands.MissingPermissions):
            await ctx.send("このコマンドを使用するには、チャンネルの管理権限が必要です。")

    @commands.command(name="setyoubou")
    @commands.has_permissions(manage_channels=True)
    async def set_youbou(self, ctx):
        """要望用チャンネルとして設定します（!setyoubou）"""
        await self._setup_channel(ctx, "request")

    @commands.command(name="set")
    @commands.has_permissions(manage_channels=True)
    async def set_normal(self, ctx):
        """通常の匿名チャンネルとして設定します（!set）"""
        await self._setup_channel(ctx, "normal")

    async def _setup_channel(self, ctx, channel_type):
        channel_id = str(ctx.channel.id)
        
        if channel_id in self.anonymous_channels_data:
            old_msg_id = self.anonymous_channels_data[channel_id].get("button_message_id")
            if old_msg_id:
                try:
                    msg = await ctx.channel.fetch_message(old_msg_id)
                    await msg.delete()
                except (discord.NotFound, discord.Forbidden):
                    pass
            
            del self.anonymous_channels_data[channel_id]
            save_json(CHANNELS_FILE, self.anonymous_channels_data)
            
            await ctx.send("このチャンネルの匿名設定を解除しました。", delete_after=10)
            try:
                await ctx.message.delete()
            except: pass
            return

        webhooks = await ctx.channel.webhooks()
        webhook = next((wh for wh in webhooks if wh.name == "Tokumei Webhook"), None)
        if not webhook:
            try:
                webhook = await ctx.channel.create_webhook(name="Tokumei Webhook")
            except discord.Forbidden:
                await ctx.send("エラー：Webhookを作成する権限がありません。")
                return

        self.anonymous_channels_data[channel_id] = {
            "webhook_url": webhook.url,
            "logging_enabled": True,
            "channel_type": channel_type
        }
        save_json(CHANNELS_FILE, self.anonymous_channels_data)
        
        await update_button_message(
            self.bot, ctx.channel, channel_id, self.anonymous_channels_data, self.button_update_locks,
            lambda cid, mode="normal": AnonymousPostView(self.bot, cid, self.anonymous_channels_data, self.banned_users, self.button_update_locks, mode=mode)
        )
        
        try:
            await ctx.message.delete()
        except: pass

    @app_commands.command(name="state", description="ユーザーの状態を確認・変更します。")
    @app_commands.describe(user_id="状態を確認するユーザーのID")
    async def state(self, interaction: discord.Interaction, user_id: str):
        if not is_authorized(interaction):
            await interaction.response.send_message("この操作を行う権限がありません。", ephemeral=True)
            return

        await interaction.response.defer(ephemeral=True)
        try:
            target_user = await self.bot.fetch_user(int(user_id))
        except (discord.NotFound, ValueError):
            await interaction.followup.send("指定されたIDのユーザーが見つかりませんでした。", ephemeral=True)
            return

        banned_users = load_json(BANNED_USERS_FILE, {})
        is_banned = user_id in banned_users

        embed = discord.Embed(title="ユーザー状態", color=discord.Color.red() if is_banned else discord.Color.green())
        embed.set_thumbnail(url=target_user.display_avatar.url)
        embed.add_field(name="ユーザー", value=f"{target_user.mention} (`{user_id}`)", inline=False)
        
        if is_banned:
            ban_info = banned_users[user_id]
            reason = ban_info.get('reason', '理由なし')
            expires_at_str = ban_info.get('expires_at')
            
            embed.add_field(name="状態", value="<:12:1407591937728577599> **BANされています**", inline=False)
            embed.add_field(name="理由", value=reason, inline=False)
            
            if expires_at_str:
                try:
                    exp_ts = int(datetime.fromisoformat(expires_at_str).timestamp())
                    embed.add_field(name="解除予定", value=f"<t:{exp_ts}:F> (<t:{exp_ts}:R>)", inline=False)
                except ValueError:
                    embed.add_field(name="解除予定", value="無期限", inline=False)
            else:
                embed.add_field(name="解除予定", value="無期限", inline=False)
        else:
            embed.add_field(name="状態", value="<:10:1407591891318472794> **正常です**", inline=False)
            
        from ui.views import UserStateView
        view = UserStateView(target_user_id=user_id, is_banned=is_banned, interaction=interaction)
        await interaction.followup.send(embed=embed, view=view, ephemeral=True)

    @app_commands.command(name="border", description="通報が管理者に通知されるまでの閾値を設定します。")
    @app_commands.describe(count="必要通報人数")
    async def border_count(self, interaction: discord.Interaction, count: int):
        if not is_authorized(interaction):
            await interaction.response.send_message("権限がありません。", ephemeral=True)
            return
        
        settings = load_json(THRESHOLDS_FILE, DEFAULT_THRESHOLDS)
        settings["report"] = count
        save_json(THRESHOLDS_FILE, settings)
        await interaction.response.send_message(f"通報閾値を `{count}` 人に設定しました。", ephemeral=True)

    @app_commands.command(name="word", description="禁止キーワードを設定（追加・削除）します。")
    @app_commands.describe(action="実行する操作", value="キーワード")
    @app_commands.choices(action=[
        app_commands.Choice(name="追加 (add)", value="add"),
        app_commands.Choice(name="削除 (remove)", value="remove")
    ])
    async def word_manage(self, interaction: discord.Interaction, action: str, value: str):
        if not is_authorized(interaction):
            await interaction.response.send_message("権限がありません。", ephemeral=True)
            return
        words = load_json(KEYWORDS_FILE, DEFAULT_KEYWORDS)
        if action == "add":
            if value.lower() not in words:
                words.append(value.lower())
                save_json(KEYWORDS_FILE, words)
                await interaction.response.send_message(f"禁止ワードに `{value}` を追加しました。", ephemeral=True)
            else:
                await interaction.response.send_message("既に存在します。", ephemeral=True)
        else:
            if value.lower() in words:
                words.remove(value.lower())
                save_json(KEYWORDS_FILE, words)
                await interaction.response.send_message(f"禁止ワードから `{value}` を削除しました。", ephemeral=True)
            else:
                await interaction.response.send_message("見つかりませんでした。", ephemeral=True)

    @app_commands.command(name="domain", description="禁止ドメインを設定（追加・削除）します。")
    @app_commands.describe(action="実行する操作", value="ドメイン")
    @app_commands.choices(action=[
        app_commands.Choice(name="追加 (add)", value="add"),
        app_commands.Choice(name="削除 (remove)", value="remove")
    ])
    async def domain_manage(self, interaction: discord.Interaction, action: str, value: str):
        if not is_authorized(interaction):
            await interaction.response.send_message("権限がありません。", ephemeral=True)
            return
        domains = load_json(DOMAINS_FILE, DEFAULT_DOMAINS)
        if action == "add":
            if value.lower() not in domains:
                domains.append(value.lower())
                save_json(DOMAINS_FILE, domains)
                await interaction.response.send_message(f"禁止ドメインに `{value}` を追加しました。", ephemeral=True)
            else:
                await interaction.response.send_message("既に存在します。", ephemeral=True)
        else:
            if value.lower() in domains:
                domains.remove(value.lower())
                save_json(DOMAINS_FILE, domains)
                await interaction.response.send_message(f"禁止ドメインから `{value}` を削除しました。", ephemeral=True)
            else:
                await interaction.response.send_message("見つかりませんでした。", ephemeral=True)

    @app_commands.command(name="list", description="各種設定・状態の一覧を表示します。")
    @app_commands.describe(category="表示するカテゴリ")
    @app_commands.choices(category=[
        app_commands.Choice(name="禁止キーワード (word)", value="word"),
        app_commands.Choice(name="禁止ドメイン (domain)", value="domain"),
        app_commands.Choice(name="制限ユーザー (ban)", value="ban")
    ])
    async def list_commands(self, interaction: discord.Interaction, category: str):
        if not is_authorized(interaction):
            await interaction.response.send_message("権限がありません。", ephemeral=True)
            return
        
        if category == "word":
            words = load_json(KEYWORDS_FILE, DEFAULT_KEYWORDS)
            embed = discord.Embed(title="禁止キーワード一覧", description=", ".join(f"`{w}`" for w in words) or "なし", color=discord.Color.blue())
            await interaction.response.send_message(embed=embed, ephemeral=True)
        elif category == "domain":
            domains = load_json(DOMAINS_FILE, DEFAULT_DOMAINS)
            embed = discord.Embed(title="禁止ドメイン一覧", description=", ".join(f"`{d}`" for d in domains) or "なし", color=discord.Color.blue())
            await interaction.response.send_message(embed=embed, ephemeral=True)
        elif category == "ban":
            banned_users = load_json(BANNED_USERS_FILE, {})
            if not banned_users:
                await interaction.response.send_message("現在制限されているユーザーはいません。", ephemeral=True)
                return
            embed = discord.Embed(title="利用制限ユーザー一覧", color=discord.Color.red())
            for uid, info in banned_users.items():
                reason = info.get('reason', '理由なし')
                exp_str = info.get('expires_at')
                if exp_str:
                    try:
                        exp_ts = int(datetime.fromisoformat(exp_str).timestamp())
                        exp_val = f"<t:{exp_ts}:F> (<t:{exp_ts}:R>)"
                    except ValueError: exp_val = "無期限"
                else: exp_val = "無期限"
                embed.add_field(name=f"ID: {uid}", value=f"ユーザー: <@{uid}>\n理由: {reason}\n解除: {exp_val}", inline=False)
            await interaction.response.send_message(embed=embed, ephemeral=True)



    @app_commands.command(name="log", description="ログ関連の設定（スイッチ・チャンネル）を行います。")
    @app_commands.describe(action="実行する操作", value="設定値（ON/OFF または チャンネル）")
    @app_commands.choices(action=[
        app_commands.Choice(name="ON/OFF切替", value="switch"),
        app_commands.Choice(name="通知チャンネル設定", value="channel"),
        app_commands.Choice(name="処罰ログチャンネル設定", value="punish_channel")
    ])
    async def log_manage(self, interaction: discord.Interaction, action: str, value: str = None, channel: discord.TextChannel = None):
        if not is_authorized(interaction):
            await interaction.response.send_message("権限がありません。", ephemeral=True)
            return
        
        if action == "switch":
            channel_id = str(interaction.channel.id)
            if channel_id not in self.anonymous_channels_data:
                await interaction.response.send_message("匿名チャンネルではありません。", ephemeral=True)
                return
            if not value:
                await interaction.response.send_message("ON または OFF を指定してください。", ephemeral=True)
                return
            is_on = (value.lower() == "on")
            self.anonymous_channels_data[channel_id]["logging_enabled"] = is_on
            save_json(CHANNELS_FILE, self.anonymous_channels_data) 
            await interaction.response.send_message(f"ログ保存を{'ON' if is_on else 'OFF'}に設定しました。", ephemeral=True)
        elif action == "channel":
            if not channel:
                await interaction.response.send_message("通知先のチャンネルを指定してください。", ephemeral=True)
                return
            guild_settings = load_json(GUILD_SETTINGS_FILE, {})
            guild_id = str(interaction.guild.id)
            guild_settings.setdefault(guild_id, {})["report_channel_id"] = str(channel.id)
            save_json(GUILD_SETTINGS_FILE, guild_settings)
            await interaction.response.send_message(f"ログチャンネルを {channel.mention} に設定しました。", ephemeral=True)
        elif action == "punish_channel":
            if not channel:
                await interaction.response.send_message("処罰ログ通知先のチャンネルを指定してください。", ephemeral=True)
                return
            guild_settings = load_json(GUILD_SETTINGS_FILE, {})
            guild_id = str(interaction.guild.id)
            guild_settings.setdefault(guild_id, {})["punish_log_channel_id"] = str(channel.id)
            save_json(GUILD_SETTINGS_FILE, guild_settings)
            await interaction.response.send_message(f"処罰ログチャンネルを {channel.mention} に設定しました。", ephemeral=True)

    @app_commands.command(name="ban", description="ユーザーを手動でBANします。")
    @app_commands.describe(user_id="BANするユーザーのID", days="BAN日数 (0で永久)", reason="BANの理由")
    async def manual_ban(self, interaction: discord.Interaction, user_id: str, days: int, reason: str = "理由なし"):
        if not is_authorized(interaction):
            await interaction.response.send_message("権限がありません。", ephemeral=True)
            return
        banned_users = load_json(BANNED_USERS_FILE, {})
        expires_at = None
        if days > 0:
            expires_at = (datetime.now() + timedelta(days=days)).isoformat()
        banned_users[user_id] = {
            "reason": reason,
            "message_content": "Manual BAN",
            "expires_at": expires_at
        }
        save_json(BANNED_USERS_FILE, banned_users)
        ban_type = f"{days}日間の制限" if days > 0 else "無期限の制限"
        try:
            target_user = await self.bot.fetch_user(int(user_id))
            embed = discord.Embed(
                title="<:12:1407591937728577599> 匿名チャット利用制限",
                description=f"運営によって, 匿名チャットの利用が制限されました。\n種別: **{ban_type}**",
                color=discord.Color.red()
            )
            embed.add_field(name="理由", value=reason, inline=False)
            if expires_at:
                exp_ts = int(datetime.fromisoformat(expires_at).timestamp())
                embed.add_field(name="解除予定", value=f"<t:{exp_ts}:F>", inline=False)
            await target_user.send(embed=embed)
            dm_status = "（通知DM送信済み）"
        except Exception: dm_status = "（通知DM送信失敗）"
        await interaction.response.send_message(f"ユーザー `{user_id}` を {ban_type} でBANしました。{dm_status}", ephemeral=True)

async def setup(bot, anonymous_channels_data, banned_users, button_update_locks):
    await bot.add_cog(AdminCog(bot, anonymous_channels_data, banned_users, button_update_locks))
