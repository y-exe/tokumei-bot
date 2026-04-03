import discord
from datetime import datetime, timedelta
from ui.modals import AnonymousPostModal, ReplyModal

# ヘルプ・詳細のところ
class HelpView(discord.ui.View):
    def __init__(self, channel_id: str, anonymous_channels_data):
        super().__init__(timeout=None)
        self.channel_id = channel_id
        self.anonymous_channels_data = anonymous_channels_data

    @discord.ui.button(label="1", style=discord.ButtonStyle.secondary, emoji="1️⃣", custom_id="help_1")
    async def help_1(self, interaction: discord.Interaction, button: discord.ui.Button):
        embed = discord.Embed(title="<a:1_:1401169042936692776> 利用規約", color=discord.Color.blue())
        embed.description = (
            "匿名チャンネルでは\n"
            "日本国の法令、Discord利用規約、Discordガイドライン、\nまたは公序良俗に違反する行為、またはそのおそれのある行為\n"
            "それに加えて**個人への過激な誹謗中傷**は禁止しており、\n"
            "**ペナルティーが課される場合があります**\n"
            "<a:2_:1401169059235762208> 処罰は基本的に`メッセージ削除` `匿名チャット利用権限の削除`\n`DMで警告`です\n"
            "-# ※場合によってはサーバーBAN・タイムアウトもあります\n"
            "### なお, この処罰は全て匿名で行います。\n"
            "-# 詳細情報 : https://github.com/y-exe/tokumei-bot/blob/main/TERMS_OF_SERVICE.md\n"
            "-# <:5_:1407591193751195698> また, 本規約は変更される可能性があります"
        )
        embed.set_image(url="https://i.gyazo.com/4f2b4b2c8834431cfe74d87ff795e9e2.png")
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @discord.ui.button(label="2", style=discord.ButtonStyle.secondary, emoji="2️⃣", custom_id="help_2")
    async def help_2(self, interaction: discord.Interaction, button: discord.ui.Button):
        channel_data = self.anonymous_channels_data.get(self.channel_id, {})
        log_enabled = channel_data.get("logging_enabled", True)
        embed = discord.Embed(title="<a:1_:1401169042936692776> プライバシーポリシー", color=discord.Color.blue())
        if log_enabled:
            embed.description = (
                "### 匿名チャットのログ保存・利用につきまして\n"
                "<:10:1407591891318472794> このチャンネルではログ保存が`ON`になっています\n"
                "この場合、利用規約に違反するメッセージがあった場合運営が\n"
                "**直接処罰することがあります** (詳しくは利用規約)\n\n"
                "<:11:1407591910767464459> ただ, 5日以上たったメッセージはアーカイブ化します\n"
                "この場合、通報しても自動削除対応のみの対応となります\n\n"
                "-# 詳細情報  :  https://github.com/y-exe/tokumei-bot/blob/main/PRIVACY_POLICY.md\n"
                "-# <:5_:1407591193751195698> また, 本ポリシーは変更される可能性があります"
            )
        else:
            embed.description = (
                "<:11:1407591910767464459> このチャンネルではログ保存が`OFF`になっています\n"
                "**この場合、処罰は削除のみです**\n\n"
                "-# 詳細情報  :  https://github.com/y-exe/tokumei-bot/blob/main/PRIVACY_POLICY.md\n"
                "-# <:5_:1407591195698> 本ポリシーは変更される可能性があります"
            )
        embed.set_image(url="https://i.gyazo.com/6b863e103f9897b7494e70e87778432e.png")
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @discord.ui.button(label="3", style=discord.ButtonStyle.secondary, emoji="3️⃣", custom_id="help_3")
    async def help_3(self, interaction: discord.Interaction, button: discord.ui.Button):
        embed = discord.Embed(title="<:9_:1407591872234520576> メッセージ通報について", color=discord.Color.blue())
        embed.description = (
            "**<:10:1407591891318472794> メッセージ右クリ or 長押し>アプリ から\n"
            "「メッセージ通報」を押す**ことで\n"
            "メッセージの通報が可能です。"
        )
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @discord.ui.button(label="4", style=discord.ButtonStyle.secondary, emoji="4️⃣", custom_id="help_4")
    async def help_4(self, interaction: discord.Interaction, button: discord.ui.Button):
        embed = discord.Embed(title="<:9_:1407591872234520576> メッセージ削除・編集について", color=discord.Color.blue())
        embed.description = (
            "**<:10:1407591891318472794> メッセージ右クリ or 長押し>アプリ から\n"
            "「メッセージ削除」または「メッセージを編集」を押す**ことで\n"
            "指定の動作が可能です\n"
            "-# <:5_:1407591193751195698> ※ただし、削除しても事前に通報された場合メッセージ内容は残ります"
        )
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @discord.ui.button(label="5", style=discord.ButtonStyle.secondary, emoji="5️⃣", custom_id="help_5")
    async def help_5(self, interaction: discord.Interaction, button: discord.ui.Button):
        embed = discord.Embed(title="<:9_:1407591872234520576> その他詳細", color=discord.Color.blue())
        embed.description = (
            "<:10:1407591891318472794> **このBotはWebhookを使い匿名チャットを再現するものです**\n"
            "匿名の性質上荒れることが多いため,\n"
            "`動画のブロック` `画像のNSFW・グロ検知` `キーワード、ドメインブロック`\nを導入しています。\n"
            "またログが`ON`になっているチャンネルでは**通報機能**を実装しています。\n\n"
            "<:3_:1407591152491827211> また, 荒れすぎた場合\n"
            "**ルール改正や処罰、検閲体制の変更、サ終を検討することもあります。**\n"
            "### <:11:1407591910767464459> 基本フリーですが限度を守ってご利用ください\n"
            "https://github.com/y-exe/tokumei-bot\n"
            "作成者 <@1438769007636385914>\n\n"
            "**メッセージは必ずボタンから送信してください!!**"
        )
        embed.set_image(url="https://i.gyazo.com/d383abacd30bc6afda9b94227d2af790.png")
        await interaction.response.send_message(embed=embed, ephemeral=True)

class AnonymousPostView(discord.ui.View):
    def __init__(self, bot, channel_id: str, anonymous_channels_data, banned_users, button_update_locks, mode="normal"):
        super().__init__(timeout=None)
        self.bot = bot
        self.channel_id = channel_id
        self.anonymous_channels_data = anonymous_channels_data
        self.banned_users = banned_users
        self.button_update_locks = button_update_locks
        
        if mode == "request":
            self.remove_item(self.help_button)

    @discord.ui.button(label='クリックして匿名で送信', style=discord.ButtonStyle.primary, emoji='✍️', custom_id='anonymous_post_button')
    async def post_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(AnonymousPostModal(self.bot, self.anonymous_channels_data, self.banned_users, self.button_update_locks))

    @discord.ui.button(label='画像送信', style=discord.ButtonStyle.success, emoji='🖼️', custom_id='image_post_button')
    async def image_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        image_id = getattr(self.bot, "image_command_id", "1488490168854908979")
        mention = f"</image:{image_id}>"
        description_text = f"## 下のボタンを押して画像を挿入してください\n{' '.join([mention] * 24)}"
        
        embed = discord.Embed(description=description_text, color=discord.Color.blue())
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @discord.ui.button(label='ヘルプ・詳細', style=discord.ButtonStyle.secondary, custom_id='help_button')
    async def help_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        embed = discord.Embed(
            title="ヘルプ・詳細", 
            description="**1️⃣ : 利用規約\n2️⃣ : プライバシーポリシー\n3️⃣ : 通報について\n4️⃣ : 削除・編集について\n5️⃣ : その他詳細**", 
            color=discord.Color.blue()
        )
        await interaction.response.send_message(embed=embed, view=HelpView(self.channel_id, self.anonymous_channels_data), ephemeral=True)

class ReportConfirmView(discord.ui.View):
    def __init__(self, bot, original_interaction: discord.Interaction, message: discord.Message, anonymous_channels_data, report_data):
        super().__init__(timeout=60)
        self.bot = bot
        self.original_interaction = original_interaction
        self.message = message
        self.anonymous_channels_data = anonymous_channels_data
        self.report_data = report_data

    @discord.ui.button(label="はい", style=discord.ButtonStyle.danger)
    async def confirm_report(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.defer(ephemeral=True)
        from core.anonymous_logic import process_report
        response_message = await process_report(self.bot, self.original_interaction, self.message, self.anonymous_channels_data, self.report_data)
        await interaction.followup.send(response_message, ephemeral=True)
        self.stop()

    @discord.ui.button(label="キャンセル", style=discord.ButtonStyle.secondary)
    async def cancel_report(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.edit_message(content="通報をキャンセルしました。", view=None, embed=None)
        self.stop()

class ReportView(discord.ui.View):
    def __init__(self, user_id: str, content: str, message: discord.Message):
        super().__init__(timeout=None)
        self.user_id = user_id
        self.content = content
        self.message = message

    @discord.ui.button(label="処罰", style=discord.ButtonStyle.danger, custom_id="punish_button")
    async def punish_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        from ui.modals import PunishConfirmModal
        await interaction.response.send_modal(PunishConfirmModal(self.user_id, self.content, interaction.message))

    @discord.ui.button(label="処罰なし", style=discord.ButtonStyle.primary, custom_id="no_punish_button")
    async def no_punish_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        embed = interaction.message.embeds[0]
        embed.description = (embed.description or "") + "\n**終了済み**"
        await interaction.message.edit(embed=embed, view=None)
        await interaction.response.send_message("処罰なしで処理を終了しました。", ephemeral=True)

    @discord.ui.button(label="メッセージを確認", style=discord.ButtonStyle.secondary, custom_id="view_message_button")
    async def view_message_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_message(f"メッセージリンク: {self.message.jump_url}", ephemeral=True)

class PunishConfirmView(discord.ui.View):
    def __init__(self, user_id: str, content: str, original_report_message: discord.Message, days: int, reason: str):
        super().__init__(timeout=300)
        self.user_id = user_id
        self.content = content
        self.original_report_message = original_report_message
        self.days = days
        self.reason = reason

    @discord.ui.button(label="はい", style=discord.ButtonStyle.danger)
    async def confirm_punish(self, interaction: discord.Interaction, button: discord.ui.Button):
        from utils.json_helper import load_json, save_json
        from models.constants import BANNED_USERS_FILE
        banned_users = load_json(BANNED_USERS_FILE, {})
        
        expires_at = None
        if self.days > 0:
            expires_at = (datetime.now() + timedelta(days=self.days)).isoformat()
            
        banned_users[self.user_id] = {
            "reason": self.reason, 
            "message_content": self.content,
            "expires_at": expires_at
        }
        save_json(BANNED_USERS_FILE, banned_users)

        try:
            user = await interaction.client.fetch_user(int(self.user_id))
            ban_type = f"{self.days}日間の制限" if self.days > 0 else "無期限の制限"
            embed = discord.Embed(
                title="<:12:1407591937728577599> 匿名チャット利用制限",
                description=f"利用規約遵守のため, 匿名チャットの利用が制限されました。\n種別: **{ban_type}**",
                color=discord.Color.red()
            )
            embed.add_field(name="理由", value=self.reason, inline=False)
            embed.add_field(name="違反メッセージ", value=f"```{self.content[:1000]}```", inline=False)
            if expires_at:
                exp_ts = int(datetime.fromisoformat(expires_at).timestamp())
                embed.add_field(name="解除予定", value=f"<t:{exp_ts}:F>", inline=False)
            await user.send(embed=embed)
        except Exception as e:
            print(f"DM送信エラー: {e}")

        if self.original_report_message.embeds:
            embed = self.original_report_message.embeds[0]
            embed.description = (embed.description or "") + "\n**終了済み**"
            await self.original_report_message.edit(embed=embed, view=None)
        
        await interaction.response.send_message(f"処罰（{ban_type}）を実行しました。", ephemeral=True)
        self.stop()

    @discord.ui.button(label="キャンセル", style=discord.ButtonStyle.secondary)
    async def cancel_punish(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_message("キャンセルしました。", ephemeral=True)
        self.stop()

class UserStateView(discord.ui.View):
    def __init__(self, target_user_id: str, is_banned: bool, interaction: discord.Interaction):
        super().__init__(timeout=180)
        self.target_user_id = target_user_id
        self.is_banned = is_banned
        self.interaction = interaction
        self.update_buttons()

    def update_buttons(self):
        self.clear_items()
        if self.is_banned:
            self.add_item(discord.ui.Button(label="BANを解除", style=discord.ButtonStyle.success, custom_id="unban_user"))
        else:
            self.add_item(discord.ui.Button(label="BANを付与", style=discord.ButtonStyle.danger, custom_id="ban_user"))
        self.children[0].callback = self.button_callback
    
    async def button_callback(self, interaction: discord.Interaction):
        from core.anonymous_logic import is_authorized
        if not is_authorized(interaction):
            await interaction.response.send_message("この操作を行う権限がありません。", ephemeral=True)
            return
        
        from utils.json_helper import load_json, save_json
        from models.constants import BANNED_USERS_FILE
        banned_users = load_json(BANNED_USERS_FILE, {})
        
        result_text = ""
        if self.is_banned:
            if self.target_user_id in banned_users:
                del banned_users[self.target_user_id]
                save_json(BANNED_USERS_FILE, banned_users)
                result_text = "BANを解除しました。"
                self.is_banned = False
                
                try:
                    user = await interaction.client.fetch_user(int(self.target_user_id))
                    embed = discord.Embed(
                        title="<:10:1407591891318472794> 匿名チャット利用制限の解除",
                        description="運営によって, 匿名チャットの利用制限が解除されました。\n現在は通常通り投稿が可能です。",
                        color=discord.Color.green()
                    )
                    await user.send(embed=embed)
                except Exception as e:
                    print(f"解除DM送信エラー: {e}")
            else:
                result_text = "このユーザーは既にBANされていませんでした。"
        else:
            if self.target_user_id not in banned_users:
                from ui.modals import ManualPunishModal
                await interaction.response.send_modal(ManualPunishModal(self.target_user_id, self))
                return
            else:
                result_text = "このユーザーは既にBANされています。"

        for item in self.children:
            item.disabled = True
            
        original_embed = interaction.message.embeds[0]
        original_embed.add_field(name="実行結果", value=result_text, inline=False)
        original_embed.color = discord.Color.green() if not self.is_banned else discord.Color.red()
        
        await interaction.response.edit_message(embed=original_embed, view=self)
        self.stop()
    
    async def on_timeout(self):
        for item in self.children:
            item.disabled = True
        try:
            await self.interaction.edit_original_response(view=self)
        except: pass
