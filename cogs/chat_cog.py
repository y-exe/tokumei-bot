import discord
from discord.ext import commands
from discord import app_commands
import os
import re
from datetime import datetime, timezone, timedelta
from models.constants import *
from utils.json_helper import load_json, save_json
from utils.logging_helper import get_log_file_path
from core.anonymous_logic import send_anonymous_message, update_button_message, is_authorized
from ui.modals import ReplyModal, EditMessageModal
from ui.views import AnonymousPostView

class ChatCog(commands.Cog):
    def __init__(self, bot, anonymous_channels_data, banned_users, button_update_locks):
        self.bot = bot
        self.anonymous_channels_data = anonymous_channels_data
        self.banned_users = banned_users
        self.button_update_locks = button_update_locks
        self.report_data = {}

        self.bot.tree.add_command(app_commands.ContextMenu(name="メッセージに返信", callback=self.reply_to_message))
        self.bot.tree.add_command(app_commands.ContextMenu(name="メッセージを編集", callback=self.edit_message))
        self.bot.tree.add_command(app_commands.ContextMenu(name="メッセージを削除", callback=self.delete_message))
        self.bot.tree.add_command(app_commands.ContextMenu(name="匿名つぶやき通報", callback=self.report_message))

    async def report_message(self, interaction: discord.Interaction, message: discord.Message):
        if message.webhook_id is None:
            await interaction.response.send_message("匿名メッセージ（Webhookからの投稿）のみ通報できます。", ephemeral=True)
            return

        from ui.views import ReportConfirmView
        embed = discord.Embed(title="このメッセージを通報しますか？", color=discord.Color.orange())
        embed.add_field(name="メッセージ内容", value=f"```{message.content[:1000]}```", inline=False)
        view = ReportConfirmView(self.bot, interaction, message, self.anonymous_channels_data, self.report_data)
        await interaction.response.send_message(embed=embed, view=view, ephemeral=True)

    async def reply_to_message(self, interaction: discord.Interaction, message: discord.Message):
        if not message.webhook_id:
            await interaction.response.send_message("匿名メッセージにのみ返信できます。", ephemeral=True)
            return

        message_logs = load_json(MESSAGE_LOGS_FILE, {})
        log_entry = message_logs.get(str(message.id))
        if not log_entry or "anonymous_id" not in log_entry:
            await interaction.response.send_message("返信先のメッセージ情報が見つかりませんでした。", ephemeral=True)
            return
        
        modal = ReplyModal(
            self.bot, message, str(log_entry["anonymous_id"]),
            self.anonymous_channels_data, self.banned_users, self.button_update_locks
        )
        await interaction.response.send_modal(modal)

    async def edit_message(self, interaction: discord.Interaction, message: discord.Message):
        message_logs = load_json(MESSAGE_LOGS_FILE, {})
        log_entry = message_logs.get(str(message.id))
        
        if not log_entry or str(interaction.user.id) != log_entry.get("user_id"):
            await interaction.response.send_message("これはあなたが編集できるメッセージではありません。", ephemeral=True)
            return
        
        channel_data = self.anonymous_channels_data.get(str(interaction.channel_id), {})
        if not (webhook_url := channel_data.get("webhook_url")):
            await interaction.response.send_message("このチャンネルのWebhook設定が見つかりません。", ephemeral=True)
            return

        modal = EditMessageModal(bot=self.bot, webhook_url=webhook_url, message_id=message.id)
        modal.content_input.default = message.content
        await interaction.response.send_modal(modal)

    async def delete_message(self, interaction: discord.Interaction, message: discord.Message):
        message_logs = load_json(MESSAGE_LOGS_FILE, {})
        log_entry = message_logs.get(str(message.id))

        if not log_entry or str(interaction.user.id) != log_entry.get("user_id"):
            await interaction.response.send_message("これはあなたが削除できるメッセージではありません。", ephemeral=True)
            return
        
        channel_data = self.anonymous_channels_data.get(str(interaction.channel_id), {})
        if not (webhook_url := channel_data.get("webhook_url")):
            await interaction.response.send_message("このチャンネルのWebhook設定が見つかりません。", ephemeral=True)
            return
            
        try:
            webhook = discord.Webhook.from_url(webhook_url, session=self.bot.http._HTTPClient__session)
            await webhook.delete_message(message.id)
            await interaction.response.send_message("メッセージを削除しました。", ephemeral=True)
            
            for i in range(6):
                log_file = get_log_file_path(datetime.now(timezone.utc) - timedelta(days=i))
                if os.path.exists(log_file) and str(message.id) in (log_data := load_json(log_file, {})):
                    del log_data[str(message.id)]
                    save_json(log_file, log_data)
                    break
            
            del message_logs[str(message.id)]
            save_json(MESSAGE_LOGS_FILE, message_logs)
                
        except Exception as e:
            await interaction.response.send_message(f"削除中にエラーが発生しました: {e}", ephemeral=True)

    @app_commands.command(name="image", description="匿名チャンネルに画像を投稿します。")
    @app_commands.describe(attachment="投稿する画像", content="添えるメッセージ（任意）")
    async def post_image(self, interaction: discord.Interaction, attachment: discord.Attachment, content: str = ""):
        if str(interaction.channel.id) not in self.anonymous_channels_data:
            await interaction.response.send_message("このチャンネルは匿名チャンネルではありません。", ephemeral=True)
            return

        from core.anonymous_logic import check_ban, send_anonymous_message
        if await check_ban(interaction):
            return

        if content:
            blocked_keywords = load_json(KEYWORDS_FILE, DEFAULT_KEYWORDS)
            for keyword in blocked_keywords:
                if keyword.lower() in content.lower():
                    embed = discord.Embed(title="キーワードブロック", description="不適切な可能性のあるキーワードを検出したため、送信をブロックしました。", color=discord.Color.red())
                    await interaction.response.send_message(embed=embed, ephemeral=True)
                    return

        await interaction.response.defer(ephemeral=True)
        success = await send_anonymous_message(self.bot, interaction, content, self.anonymous_channels_data, attachment=attachment)
        if success:
            from ui.views import AnonymousPostView
            channel_data = self.anonymous_channels_data.get(str(interaction.channel.id), {})
            mode = channel_data.get("channel_type", "normal")
            view_factory = lambda cid, mode=mode: AnonymousPostView(self.bot, cid, self.anonymous_channels_data, self.banned_users, self.button_update_locks, mode=mode)
            await update_button_message(self.bot, interaction.channel, str(interaction.channel.id), self.anonymous_channels_data, self.button_update_locks, view_factory)
            await interaction.followup.send("画像を投稿しました。", ephemeral=True)
        else:
            await interaction.followup.send("画像の投稿に失敗しました。", ephemeral=True)

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        if message.author.bot: return
        channel_id = str(message.channel.id)
        if channel_id in self.anonymous_channels_data:
            # 要望用チャンネル（request）の場合はメッセージを削除しないが、
            # ボタンメッセージを最下部に維持（リスン）するために更新を行う
            channel_data = self.anonymous_channels_data[channel_id]
            if channel_data.get("channel_type") == "request":
                from core.anonymous_logic import update_button_message
                from ui.views import AnonymousPostView
                mode = "request"
                view_factory = lambda cid, mode=mode: AnonymousPostView(self.bot, cid, self.anonymous_channels_data, self.banned_users, self.button_update_locks, mode=mode)
                await update_button_message(self.bot, message.channel, channel_id, self.anonymous_channels_data, self.button_update_locks, view_factory)
                return

            is_admin = is_authorized(message)
            if not is_admin:
                try:
                    await message.delete()
                    embed = discord.Embed(title="メッセージを削除しました", color=discord.Color.red())
                    embed.description = (
                        "匿名チャンネルでは、通常のメッセージ送信はできません。\n"
                        "必ずボタンからメッセージを送信してください。"
                    )
                    embed.add_field(name="送信しようとしたメッセージ", value=f"```{message.content[:1000]}```", inline=False)
                    embed.set_image(url="https://i.gyazo.com/d383abacd30bc6afda9b94227d2af790.png")
                    await message.author.send(embed=embed)
                except discord.Forbidden:
                    print(f"メッセージ削除失敗: チャンネル {message.channel.name} で権限がありません。")
                except Exception as e:
                    print(f"メッセージ削除中の予期せぬエラー: {e}")

async def setup(bot, anonymous_channels_data, banned_users, button_update_locks):
    await bot.add_cog(ChatCog(bot, anonymous_channels_data, banned_users, button_update_locks))
