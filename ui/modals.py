import discord
import re
from models.constants import *
from utils.json import load_json
from core.logic import send_anonymous_message, update_button_message

class AnonymousPostModal(discord.ui.Modal, title='匿名メッセージを送信'):
    content_input = discord.ui.TextInput(
        label='メッセージ内容', style=discord.TextStyle.paragraph,
        placeholder='ここに送信したいメッセージを入力してください...', required=True, max_length=2000
    )

    def __init__(self, bot, anonymous_channels_data, button_update_locks):
        super().__init__()
        self.bot = bot
        self.anonymous_channels_data = anonymous_channels_data
        self.button_update_locks = button_update_locks

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True, thinking=False)

        blocked_keywords = load_json(KEYWORDS_FILE, DEFAULT_KEYWORDS)
        for keyword in blocked_keywords:
            if keyword.lower() in self.content_input.value.lower():
                embed = discord.Embed(title="キーワードブロック", description="不適切な可能性のあるキーワードを検出したため、送信をブロックしました。", color=discord.Color.red())
                await interaction.followup.send(embed=embed, ephemeral=True)
                return

        mention_pattern = r"<@!?&?[0-9]{17,20}>|@everyone|@here"
        if re.search(mention_pattern, self.content_input.value):
            await interaction.followup.send('エラー: メンションを含むメッセージは送信できません。', ephemeral=True)
            return

        from ui.views import AnonymousPostView
        channel_data = self.anonymous_channels_data.get(str(interaction.channel.id), {})
        mode = channel_data.get("channel_type", "normal")
        view_factory = lambda cid, mode=mode: AnonymousPostView(self.bot, cid, self.anonymous_channels_data, self.button_update_locks, mode=mode)

        if not await send_anonymous_message(self.bot, interaction, self.content_input.value, self.anonymous_channels_data):
            await interaction.followup.send('メッセージの送信中にエラーが発生しました。', ephemeral=True)
        else:
            await update_button_message(self.bot, interaction.channel, str(interaction.channel.id), self.anonymous_channels_data, self.button_update_locks, view_factory)

class ReplyModal(discord.ui.Modal, title="メッセージに返信"):
    content_input = discord.ui.TextInput(
        label="返信内容", style=discord.TextStyle.paragraph,
        placeholder="返信メッセージを入力してください...", required=True, max_length=1900
    )

    def __init__(self, bot, target_message: discord.Message, target_anonymous_id: str, anonymous_channels_data, button_update_locks):
        super().__init__()
        self.bot = bot
        self.target_message = target_message
        self.target_anonymous_id = target_anonymous_id
        self.anonymous_channels_data = anonymous_channels_data
        self.button_update_locks = button_update_locks

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True, thinking=False)
        
        reply_prefix = f"[>>{self.target_anonymous_id}]({self.target_message.jump_url})\n"
        full_content = reply_prefix + self.content_input.value
        
        from ui.views import AnonymousPostView
        channel_data = self.anonymous_channels_data.get(str(interaction.channel.id), {})
        mode = channel_data.get("channel_type", "normal")
        view_factory = lambda cid, mode=mode: AnonymousPostView(self.bot, cid, self.anonymous_channels_data, self.button_update_locks, mode=mode)

        if not await send_anonymous_message(self.bot, interaction, full_content, self.anonymous_channels_data):
            await interaction.followup.send('返信の送信中にエラーが発生しました。', ephemeral=True)
        else:
            await update_button_message(self.bot, interaction.channel, str(interaction.channel.id), self.anonymous_channels_data, self.button_update_locks, view_factory)

class EditMessageModal(discord.ui.Modal, title='メッセージを編集'):
    content_input = discord.ui.TextInput(
        label='メッセージ内容', style=discord.TextStyle.paragraph, required=True, max_length=2000
    )

    def __init__(self, bot, webhook_url: str, message_id: int):
        super().__init__()
        self.bot = bot
        self.webhook_url = webhook_url
        self.message_id = message_id

    async def on_submit(self, interaction: discord.Interaction):
        try:
            webhook = discord.Webhook.from_url(self.webhook_url, session=self.bot.http._HTTPClient__session)
            await webhook.edit_message(self.message_id, content=self.content_input.value)
            await interaction.response.send_message("メッセージを編集しました。", ephemeral=True)
        except Exception as e:
            await interaction.response.send_message(f"編集中にエラーが発生しました: {e}", ephemeral=True)

class ReportDetailModal(discord.ui.Modal, title='メッセージの通報'):
    detail_input = discord.ui.TextInput(
        label='補足・詳細 (任意)',
        style=discord.TextStyle.paragraph,
        placeholder='未記入でも送信できます',
        required=False,
        max_length=1000
    )

    def __init__(self, bot, original_interaction, message, anonymous_channels_data, report_data):
        super().__init__()
        self.bot = bot
        self.original_interaction = original_interaction
        self.message = message
        self.anonymous_channels_data = anonymous_channels_data
        self.report_data = report_data

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        from core.logic import process_report
        report_detail = self.detail_input.value
        response_message = await process_report(self.bot, self.original_interaction, self.message, self.anonymous_channels_data, self.report_data, report_detail)
        await interaction.followup.send(response_message, ephemeral=True)

class DiscordPunishConfirmModal(discord.ui.Modal, title='処罰理由を書き込んで下さい'):
    reason_input = discord.ui.TextInput(
        label='処罰理由',
        style=discord.TextStyle.paragraph,
        placeholder='処罰理由を書き込んで下さい',
        required=True,
        max_length=500
    )

    def __init__(self, user_id: str, content: str, webhook_message: discord.Message, punish_type: str, anonymous_id: int, report_embed_message: discord.Message):
        super().__init__()
        self.user_id = user_id
        self.content = content
        self.webhook_message = webhook_message
        self.punish_type = punish_type
        self.anonymous_id = anonymous_id
        self.report_embed_message = report_embed_message

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        from core.logic import execute_discord_punishment
        success, message = await execute_discord_punishment(
            interaction,
            self.user_id,
            self.content,
            self.webhook_message,
            self.punish_type,
            self.anonymous_id,
            self.reason_input.value
        )
        
        if success and self.report_embed_message and self.report_embed_message.embeds:
            embed = self.report_embed_message.embeds[0]
            embed.description = (embed.description or "") + f"\n**終了済み ({'BAN' if self.punish_type == 'ban' else '1ヶ月TO'})**"
            await self.report_embed_message.edit(embed=embed, view=None)
        
        await interaction.followup.send(message, ephemeral=True)

