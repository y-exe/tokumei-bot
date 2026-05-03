import discord
import re
from datetime import datetime
from models.constants import *
from utils.json_helper import load_json, save_json
from core.anonymous_logic import send_anonymous_message, update_button_message, check_ban

class AnonymousPostModal(discord.ui.Modal, title='匿名メッセージを送信'):
    content_input = discord.ui.TextInput(
        label='メッセージ内容', style=discord.TextStyle.paragraph,
        placeholder='ここに送信したいメッセージを入力してください...', required=True, max_length=2000
    )

    def __init__(self, bot, anonymous_channels_data, banned_users, button_update_locks):
        super().__init__()
        self.bot = bot
        self.anonymous_channels_data = anonymous_channels_data
        self.banned_users = banned_users
        self.button_update_locks = button_update_locks

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True, thinking=False)
        if await check_ban(interaction):
            return

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
        view_factory = lambda cid, mode=mode: AnonymousPostView(self.bot, cid, self.anonymous_channels_data, self.banned_users, self.button_update_locks, mode=mode)

        if not await send_anonymous_message(self.bot, interaction, self.content_input.value, self.anonymous_channels_data):
            await interaction.followup.send('メッセージの送信中にエラーが発生しました。', ephemeral=True)
        else:
            await update_button_message(self.bot, interaction.channel, str(interaction.channel.id), self.anonymous_channels_data, self.button_update_locks, view_factory)

class ReplyModal(discord.ui.Modal, title="メッセージに返信"):
    content_input = discord.ui.TextInput(
        label="返信内容", style=discord.TextStyle.paragraph,
        placeholder="返信メッセージを入力してください...", required=True, max_length=1900
    )

    def __init__(self, bot, target_message: discord.Message, target_anonymous_id: str, anonymous_channels_data, banned_users, button_update_locks):
        super().__init__()
        self.bot = bot
        self.target_message = target_message
        self.target_anonymous_id = target_anonymous_id
        self.anonymous_channels_data = anonymous_channels_data
        self.banned_users = banned_users
        self.button_update_locks = button_update_locks

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True, thinking=False)
        if await check_ban(interaction):
            return
        
        reply_prefix = f"[>>{self.target_anonymous_id}]({self.target_message.jump_url})\n"
        full_content = reply_prefix + self.content_input.value
        
        from ui.views import AnonymousPostView
        channel_data = self.anonymous_channels_data.get(str(interaction.channel.id), {})
        mode = channel_data.get("channel_type", "normal")
        view_factory = lambda cid, mode=mode: AnonymousPostView(self.bot, cid, self.anonymous_channels_data, self.banned_users, self.button_update_locks, mode=mode)

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
        from core.anonymous_logic import process_report
        report_detail = self.detail_input.value
        response_message = await process_report(self.bot, self.original_interaction, self.message, self.anonymous_channels_data, self.report_data, report_detail)
        await interaction.followup.send(response_message, ephemeral=True)

class DiscordPunishConfirmModal(discord.ui.Modal):
    confirm_text = discord.ui.TextInput(
        label='本当に処罰しますか？',
        style=discord.TextStyle.short,
        placeholder='「はい」と入力してください',
        required=True
    )

    def __init__(self, user_id: str, content: str, webhook_message: discord.Message, punish_type: str, anonymous_id: int, report_embed_message: discord.Message):
        title = "サーバーBANの確認" if punish_type == "ban" else "1ヶ月TOの確認"
        super().__init__(title=title)
        self.user_id = user_id
        self.content = content
        self.webhook_message = webhook_message
        self.punish_type = punish_type
        self.anonymous_id = anonymous_id
        self.report_embed_message = report_embed_message

    async def on_submit(self, interaction: discord.Interaction):
        if self.confirm_text.value.lower() != "はい":
            await interaction.response.send_message("処罰をキャンセルしました。", ephemeral=True)
            return
            
        await interaction.response.defer(ephemeral=True)
        from core.anonymous_logic import execute_discord_punishment
        success, message = await execute_discord_punishment(interaction, self.user_id, self.content, self.webhook_message, self.punish_type, self.anonymous_id)
        
        if success and self.report_embed_message and self.report_embed_message.embeds:
            embed = self.report_embed_message.embeds[0]
            embed.description = (embed.description or "") + f"\n**終了済み ({'BAN' if self.punish_type == 'ban' else '1ヶ月TO'})**"
            await self.report_embed_message.edit(embed=embed, view=None)
        
        await interaction.followup.send(message, ephemeral=True)

class ManualPunishModal(discord.ui.Modal, title='利用制限の付与'):
    days_input = discord.ui.TextInput(
        label='BAN日数 (0で永久)',
        style=discord.TextStyle.short,
        placeholder='0',
        default='0',
        required=True
    )
    reason_input = discord.ui.TextInput(
        label='BAN理由',
        style=discord.TextStyle.paragraph,
        placeholder='理由を入力してください',
        default='手動による制限',
        required=True,
        max_length=500
    )

    def __init__(self, user_id: str, view_to_update=None):
        super().__init__()
        self.user_id = user_id
        self.view_to_update = view_to_update

    async def on_submit(self, interaction: discord.Interaction):
        from utils.json_helper import load_json, save_json
        from models.constants import BANNED_USERS_FILE
        from datetime import datetime, timedelta
        
        try:
            days = int(self.days_input.value)
        except ValueError:
            await interaction.response.send_message("日数は数値で入力してください。", ephemeral=True)
            return

        banned_users = load_json(BANNED_USERS_FILE, {})
        expires_at = None
        if days > 0:
            expires_at = (datetime.now() + timedelta(days=days)).isoformat()
            
        banned_users[self.user_id] = {
            "reason": self.reason_input.value,
            "message_content": "Manual BAN (via Status)",
            "expires_at": expires_at
        }
        save_json(BANNED_USERS_FILE, banned_users)

        ban_type = f"{days}日間の制限" if days > 0 else "無期限の制限"
        try:
            target_user = await interaction.client.fetch_user(int(self.user_id))
            embed = discord.Embed(
                title="<:12:1407591937728577599> 匿名チャット利用制限",
                description=f"運営によって、匿名チャットの利用が制限されました。\n種別: **{ban_type}**",
                color=discord.Color.red()
            )
            embed.add_field(name="理由", value=self.reason_input.value, inline=False)
            if expires_at:
                exp_ts = int(datetime.fromisoformat(expires_at).timestamp())
                embed.add_field(name="解除予定", value=f"<t:{exp_ts}:F>", inline=False)
            await target_user.send(embed=embed)
            dm_status = "（通知DM送信済み）"
        except Exception:
            dm_status = "（通知DM送信失敗）"

        if self.view_to_update:
            self.view_to_update.is_banned = True
            for item in self.view_to_update.children:
                item.disabled = True
            
            original_embed = interaction.message.embeds[0]
            original_embed.add_field(name="実行結果", value=f"BAN（{ban_type}）を付与しました。{dm_status}", inline=False)
            original_embed.color = discord.Color.red()
            await interaction.response.edit_message(embed=original_embed, view=self.view_to_update)
        else:
            await interaction.response.send_message(f"ユーザー `{self.user_id}` を {ban_type} でBANしました。{dm_status}", ephemeral=True)
