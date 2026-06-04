import discord
from datetime import datetime
from discord.ext import commands
from discord import app_commands
import re
from models.constants import *
from utils.json import load_json, save_json
from utils import db
from core.logic import update_button_message, is_authorized
from ui.views import AnonymousPostView, ReportView

class AdminCog(commands.Cog):
    def __init__(self, bot, anonymous_channels_data, button_update_locks):
        self.bot = bot
        self.anonymous_channels_data = anonymous_channels_data
        self.button_update_locks = button_update_locks

    @commands.Cog.listener()
    async def on_command_error(self, ctx, error):
        if isinstance(error, commands.MissingPermissions):
            await ctx.send("このコマンドを使用するには、チャンネルの管理権限が必要です。")

    @commands.command(name="setyoubou")
    @commands.has_permissions(manage_channels=True)
    async def set_youbou(self, ctx):
        await self._setup_channel(ctx, "request")

    @commands.command(name="set")
    @commands.has_permissions(manage_channels=True)
    async def set_normal(self, ctx):
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
            lambda cid, mode="normal": AnonymousPostView(self.bot, cid, self.anonymous_channels_data, self.button_update_locks, mode=mode)
        )
        
        try:
            await ctx.message.delete()
        except: pass

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
        app_commands.Choice(name="禁止ドメイン (domain)", value="domain")
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

    def _extract_message_id(self, value: str) -> str | None:
        match = re.search(r"(\d{17,20})$", value.strip())
        return match.group(1) if match else None

    async def _fetch_logged_message(self, interaction: discord.Interaction, message_id: str, source: str):
        url_match = re.search(r"discord(?:app)?\.com/channels/\d+/(\d{17,20})/(\d{17,20})", source)
        channel_ids = []
        if url_match:
            channel_ids.append(url_match.group(1))
        channel_ids.extend(cid for cid in self.anonymous_channels_data.keys() if cid not in channel_ids)

        for channel_id in channel_ids:
            try:
                channel = interaction.client.get_channel(int(channel_id)) or await interaction.client.fetch_channel(int(channel_id))
                if getattr(channel, "guild", None) and channel.guild.id != interaction.guild.id:
                    continue
                return await channel.fetch_message(int(message_id))
            except (discord.NotFound, discord.Forbidden):
                continue
            except Exception as e:
                print(f"/ban メッセージ取得エラー (channel={channel_id}, message={message_id}): {e}")
        return None

    def _build_punish_embed(self, message: discord.Message, log_entry: dict, anonymous_id: int):
        embed = discord.Embed(title="<:3_:1407591152491827211> 匿名メッセージの通報", color=discord.Color.red())

        punishment_history = load_json(PUNISHMENT_HISTORY_FILE, {})
        user_id = log_entry.get("user_id")
        if user_id and user_id in punishment_history:
            history = punishment_history[user_id]
            if isinstance(history, dict):
                count = history.get("count", 1)
                last_at_str = history.get("last_at")
                if last_at_str:
                    try:
                        last_at = datetime.fromisoformat(last_at_str)
                        diff = discord.utils.utcnow() - last_at
                        days_text = "本日" if diff.days == 0 else f"{diff.days}日前"
                        embed.description = f"**⚠️ このユーザーは以前匿名つぶやきで {count}回目 最終{days_text}に タイムアウトの処罰をされています。**\n"
                    except ValueError:
                        embed.description = f"**⚠️ このユーザーは以前匿名つぶやきで {count}回目 タイムアウトの処罰をされています。**\n"
                else:
                    embed.description = f"**⚠️ このユーザーは以前匿名つぶやきで {count}回目 タイムアウトの処罰をされています。**\n"
            else:
                embed.description = "**⚠️ このユーザーは以前匿名つぶやきでタイムアウトの処罰をされています。**\n"

        embed.add_field(
            name="メッセージの情報",
            value=(
                f"**<:6_:1407591216459153460> 送信時刻**: <t:{int(message.created_at.timestamp())}:F>\n"
                f"**<:5_:1407591193751195698> 送信内容**: ```{discord.utils.escape_markdown(message.content)[:1000]}```"
            ),
            inline=False
        )
        embed.add_field(name="<:8_:1407591279243825162> 報告人数", value="手動指定", inline=False)
        embed.add_field(name="<:7_:1407591242656911391> 報告者", value="手動指定", inline=False)
        return embed

    @app_commands.command(name="ban", description="匿名メッセージID/URLから処罰メニューを表示します。")
    @app_commands.describe(id="匿名メッセージのIDまたはメッセージURL")
    async def manual_ban(self, interaction: discord.Interaction, id: str):
        if not is_authorized(interaction):
            await interaction.response.send_message("権限がありません。", ephemeral=True)
            return

        message_id = self._extract_message_id(id)
        if not message_id:
            await interaction.response.send_message("メッセージIDまたはメッセージURLを入力してください。", ephemeral=True)
            return

        log_entry = db.get_message_log(message_id) if db.is_enabled() else load_json(MESSAGE_LOGS_FILE, {}).get(message_id)
        if not log_entry:
            await interaction.response.send_message("そのメッセージIDは匿名ログにありません。", ephemeral=True)
            return

        message = await self._fetch_logged_message(interaction, message_id, id)
        if not message:
            await interaction.response.send_message("ログにはありますが、対象メッセージを取得できませんでした。削除済み、またはBotに閲覧権限がない可能性があります。", ephemeral=True)
            return

        anonymous_id = log_entry.get("anonymous_id", 0)
        embed = self._build_punish_embed(message, log_entry, anonymous_id)
        view = ReportView(log_entry["user_id"], message.content, message, anonymous_id)
        await interaction.response.send_message(embed=embed, view=view, ephemeral=True)

async def setup(bot, anonymous_channels_data, button_update_locks):
    await bot.add_cog(AdminCog(bot, anonymous_channels_data, button_update_locks))
