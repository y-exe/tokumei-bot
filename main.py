import discord
from discord import app_commands
from discord.ext import commands
import json
import os
import re
import random
import asyncio
import aiohttp
from datetime import datetime, timedelta, timezone
from dotenv import load_dotenv
from sightengine.client import SightengineClient
import tempfile
from playwright.async_api import async_playwright

load_dotenv()

CHANNELS_FILE = 'channels.json'
USER_DATA_FILE = 'user_data.json'
THRESHOLDS_FILE = 'thresholds.json'
DOMAINS_FILE = 'domains.json'
KEYWORDS_FILE = 'keywords.json'
BANNED_USERS_FILE = 'banned_users.json'
GUILD_SETTINGS_FILE = 'guild_settings.json'

WEBHOOK_POOL_SIZE = 4

SIGHTENGINE_USER = os.getenv("SIGHTENGINE_USER")
SIGHTENGINE_SECRET = os.getenv("SIGHTENGINE_SECRET")

ALLOWED_ROLE_ID = 1368911481063866449
ALLOWED_USER_IDS = [703734573108035715, 1102557945889300480]

DEFAULT_THRESHOLDS = {"nsfw": 0.50, "guro": 0.50, "report": 3}
DEFAULT_DOMAINS = ["pornhub.com", "xvideos.com", "dlsite.com"]
DEFAULT_KEYWORDS = [
    "ロリ", "ショタ", "ペド", "児童ポルノ", "児ポ", "チャイポ", "児童性愛", "児童虐待",
    "障がい", "障害", "ガイジ", "ホモ", "レズ", "オカマ", "黒人",
    "ニガー", "奴隷", "部落", "エタ", "非人", "在日", "チョン", "メンヘラ", "殺す",
    "殺害", "消えろ", "危害", "報復", "潰す", "住所", "電話番号", "本名", "晒す",
    "特定", "電凸", "ストーカー", "DDoS", "ハッキング", "クラッキング", "自殺",
    "自死", "リスカ", "アムカ", "オーバードーズ", "首吊り", "飛び降り", "大麻",
    "マリファナ", "ガンジャ", "覚醒剤", "シャブ", "アイス", "コカイン", "MDMA", "LSD",
    "密売", "手押し", "栽培", "爆弾", "爆破", "テロ", "銃", "拳銃", "改造", "詐欺",
    "フィッシング", "リベンジポルノ", "ゴア", "グロ", "闇バイト", "裏バイト", "叩き",
    "RMT", "垢販売", "アカウント売買", "儲かる", "稼げる", "副業"
]
AVATAR_URLS = [
    "https://i.gyazo.com/f91fc95f6ff8d25c39b188a5a0cbb121.png",
    "https://i.gyazo.com/20ff74aca45b8965a997895a60a579cd.png",
    "https://i.gyazo.com/cc2c921d977f1486f5fe899627020c54.png",
    "https://i.gyazo.com/c54986b000f7374bb077839e6c9fecb9.png",
]
VIDEO_EXTENSIONS = ['mp4', 'mov', 'webm', 'avi', 'mkv', 'flv', 'gif']
CLEANUP_SECONDS = 60

def load_json(filename, default_data):
    if not os.path.exists(filename):
        with open(filename, 'w', encoding='utf-8') as f:
            json.dump(default_data, f, indent=4)
        return default_data
    try:
        with open(filename, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (json.JSONDecodeError, FileNotFoundError):
        return default_data

def save_json(filename, data):
    with open(filename, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=4)

def get_log_file_path(date):
    log_dir = f'logs/{date.strftime("%Y/%m")}'
    os.makedirs(log_dir, exist_ok=True)
    return f'{log_dir}/{date.strftime("%d")}.json'

def archive_old_logs():
    archive_file = 'logs/archive.json'
    os.makedirs('logs', exist_ok=True)
    archive_data = load_json(archive_file, {})
    cutoff_date = datetime.now(timezone.utc) - timedelta(days=5)
    
    for root, _, files in os.walk('logs'):
        for filename in files:
            if filename.endswith('.json') and filename != 'archive.json':
                file_path = os.path.join(root, filename)
                match = re.search(r'logs/(\d{4})/(\d{2})/(\d{2})\.json', file_path.replace('\\', '/'))
                if match:
                    try:
                        year, month, day = map(int, match.groups())
                        file_date = datetime(year, month, day, tzinfo=timezone.utc)
                        if file_date < cutoff_date:
                            data = load_json(file_path, {})
                            archive_data.update(data)
                            save_json(archive_file, archive_data)
                            os.remove(file_path)
                    except ValueError:
                        continue

intents = discord.Intents.default()
intents.messages = True
intents.message_content = True
intents.guilds = True

bot = commands.Bot(command_prefix='!', intents=intents)

sightengine_client = None
if SIGHTENGINE_USER and SIGHTENGINE_SECRET:
    sightengine_client = SightengineClient(SIGHTENGINE_USER, SIGHTENGINE_SECRET)

anonymous_channels_data = load_json(CHANNELS_FILE, {})
user_post_data = load_json(USER_DATA_FILE, {})
banned_users = load_json(BANNED_USERS_FILE, {})
guild_settings = load_json(GUILD_SETTINGS_FILE, {})
cleanup_tasks = {}
button_update_locks = {}
report_data = {}

async def schedule_user_data_cleanup(user_id: str):
    global cleanup_tasks
    if user_id in cleanup_tasks and not cleanup_tasks[user_id].done():
        cleanup_tasks[user_id].cancel()
    task = bot.loop.create_task(delete_user_data_after_delay(user_id))
    cleanup_tasks[user_id] = task

async def delete_user_data_after_delay(user_id: str):
    global cleanup_tasks
    await asyncio.sleep(CLEANUP_SECONDS)
    current_user_data = load_json(USER_DATA_FILE, {})
    if user_id in current_user_data:
        del current_user_data[user_id]
        save_json(USER_DATA_FILE, current_user_data)
        print(f"User {user_id} のデータを非アクティブのため削除しました。")
    if user_id in cleanup_tasks:
        del cleanup_tasks[user_id]

def is_authorized(interaction: discord.Interaction) -> bool:
    user_roles = getattr(interaction.user, 'roles', [])
    if interaction.user.id in ALLOWED_USER_IDS:
        return True
    if any(role.id == ALLOWED_ROLE_ID for role in user_roles):
        return True
    return False

class AnonymousPostModal(discord.ui.Modal, title='匿名メッセージを送信'):
    message_content = discord.ui.TextInput(
        label='メッセージ内容',
        style=discord.TextStyle.paragraph,
        placeholder='ここに送信したいメッセージを入力してください...',
        required=True,
        max_length=2000
    )

    async def on_submit(self, interaction: discord.Interaction):
        global anonymous_channels_data, user_post_data, banned_users
        await interaction.response.defer(ephemeral=True)

        if str(interaction.user.id) in banned_users:
            embed = discord.Embed(
                title="投稿エラー",
                description="ルール違反のため、匿名チャットの利用が制限されています。",
                color=discord.Color.red()
            )
            await interaction.followup.send(embed=embed, ephemeral=True)
            return

        thresholds = load_json(THRESHOLDS_FILE, DEFAULT_THRESHOLDS)
        blocked_domains = load_json(DOMAINS_FILE, DEFAULT_DOMAINS)
        blocked_keywords = load_json(KEYWORDS_FILE, DEFAULT_KEYWORDS)

        for keyword in blocked_keywords:
            if keyword.lower() in self.message_content.value.lower():
                embed = discord.Embed(title="キーワードブロック", color=discord.Color.red())
                embed.description = "Discord利用規約違反に当たる可能性のあるキーワードをブロックしました\nBotがBANされてしまう恐れがあるので**伏字など**をしてもらえると助かります"
                embed.add_field(name="検出したキーワード", value=f"`{keyword}`", inline=False)
                embed.add_field(name="元メッセージ", value=f"```{self.message_content.value[:1000]}```", inline=False)
                await interaction.followup.send(embed=embed, ephemeral=True)
                return

        urls = re.findall(r'http[s]?://(?:[a-zA-Z]|[0-9]|[$-_@.&+]|[!*\\(\\),]|(?:%[0-9a-fA-F][0-9a-fA-F]))+', self.message_content.value)
        if urls and sightengine_client:
            for url in urls:
                clean_url = url.split('?')[0]
                is_direct_image = clean_url.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.webp'))
                is_video = any(ext in clean_url.lower() for ext in VIDEO_EXTENSIONS)

                if is_video:
                    embed = discord.Embed(title="投稿ブロック", description="動画ファイルへのリンクは禁止されています。", color=discord.Color.red())
                    await interaction.followup.send(embed=embed, ephemeral=True)
                    return
                if any(domain in clean_url.lower() for domain in blocked_domains):
                    embed = discord.Embed(title="投稿ブロック", description="禁止されたサイトへのリンクが含まれています。", color=discord.Color.red())
                    await interaction.followup.send(embed=embed, ephemeral=True)
                    return

                image_to_check_path = None
                try:
                    if is_direct_image:
                        async with aiohttp.ClientSession() as session:
                            async with session.get(url, allow_redirects=True, timeout=10) as get_resp:
                                if get_resp.status != 200: continue
                                image_bytes = await get_resp.read()
                        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as temp_file:
                            temp_file.write(image_bytes)
                            image_to_check_path = temp_file.name
                    else:
                        async with async_playwright() as p:
                            browser = await p.chromium.launch()
                            page = await browser.new_page()
                            await page.goto(url, wait_until='networkidle', timeout=15000)
                            with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as temp_file:
                                await page.screenshot(path=temp_file.name, type='jpeg', quality=80)
                                image_to_check_path = temp_file.name
                            await browser.close()

                    if not image_to_check_path: continue

                    result = await bot.loop.run_in_executor(
                        None,
                        lambda: sightengine_client.check('nudity', 'gore').set_file(image_to_check_path)
                    )

                    if result['status'] == 'failure':
                        print(f"Sightengine APIエラー: {result['error']['message']}")
                        continue

                    nsfw_score = result.get('nudity', {}).get('raw')
                    if nsfw_score is not None and nsfw_score > thresholds.get("nsfw", 0.50):
                        embed = discord.Embed(title="NSFWコンテンツを検出", description="画像がNSFWコンテンツの可能性が高いと判定されたため、メッセージを送信できませんでした。", color=discord.Color.red())
                        embed.add_field(name="NSFWスコア", value=f"`{nsfw_score:.2%}`")
                        await interaction.followup.send(embed=embed, ephemeral=True)
                        return

                    guro_score = result.get('gore', {}).get('prob')
                    if guro_score is not None and guro_score > thresholds.get("guro", 0.50):
                        embed = discord.Embed(title="グロコンテンツを検出", description="画像がグロコンテンツの可能性が高いと判定されたため、メッセージを送信できませんでした。", color=discord.Color.red())
                        embed.add_field(name="グロスコア", value=f"`{guro_score:.2%}`")
                        await interaction.followup.send(embed=embed, ephemeral=True)
                        return
                except Exception as e:
                    print(f"URL解析処理中にエラーが発生しました: {e}")
                finally:
                    if image_to_check_path and os.path.exists(image_to_check_path):
                        os.remove(image_to_check_path)

        mention_pattern = r"<@!?&?[0-9]{17,20}>|@everyone|@here"
        if re.search(mention_pattern, self.message_content.value):
            await interaction.followup.send('エラー: メンションを含むメッセージは送信できません。', ephemeral=True)
            return

        channel_id = str(interaction.channel.id)
        channel_data = anonymous_channels_data.get(channel_id)

        if not channel_data or not channel_data.get("webhook_urls"):
            await interaction.followup.send('エラー: このチャンネルは匿名投稿用に正しく設定されていません。', ephemeral=True)
            return

        user_id = str(interaction.user.id)
        current_time = datetime.now(timezone.utc)

        user_post_data = load_json(USER_DATA_FILE, {})
        chosen_webhook_url = None

        if user_id in user_post_data:
            last_post_time = datetime.fromisoformat(user_post_data[user_id]["timestamp"])
            if current_time - last_post_time < timedelta(seconds=CLEANUP_SECONDS):
                if user_post_data[user_id]["webhook_url"] in channel_data["webhook_urls"]:
                    chosen_webhook_url = user_post_data[user_id]["webhook_url"]
        if not chosen_webhook_url:
            all_webhooks = channel_data["webhook_urls"]
            last_used_webhook = channel_data.get("last_webhook_url_used")
            available_webhooks = [url for url in all_webhooks if url != last_used_webhook]
            if not available_webhooks:
                available_webhooks = all_webhooks
            chosen_webhook_url = random.choice(available_webhooks)

        try:
            webhook = discord.Webhook.from_url(chosen_webhook_url, session=bot.http._HTTPClient__session)
            sent_message = await webhook.send(
                content=self.message_content.value,
                username="匿名",
                allowed_mentions=discord.AllowedMentions.none(),
                wait=True
            )
            if anonymous_channels_data.get(channel_id, {}).get("logging_enabled", True):
                log_file = get_log_file_path(current_time)
                os.makedirs(os.path.dirname(log_file), exist_ok=True)
                message_log = load_json(log_file, {})
                message_log[str(sent_message.id)] = {
                    "user_id": str(interaction.user.id),
                    "webhook_url": chosen_webhook_url,
                    "timestamp": current_time.isoformat(),
                    "content": self.message_content.value
                }
                save_json(log_file, message_log)
            user_post_data[user_id] = {
                "webhook_url": chosen_webhook_url,
                "timestamp": current_time.isoformat()
            }
            save_json(USER_DATA_FILE, user_post_data)
            anonymous_channels_data[channel_id]["last_webhook_url_used"] = chosen_webhook_url
            save_json(CHANNELS_FILE, anonymous_channels_data)
            await schedule_user_data_cleanup(user_id)
            await update_button_message(interaction.channel, channel_id)
        except Exception as e:
            await interaction.followup.send(f'予期せぬエラーが発生しました: {e}', ephemeral=True)

class EditMessageModal(discord.ui.Modal, title='メッセージを編集'):
    message_content = discord.ui.TextInput(
        label='メッセージ内容',
        style=discord.TextStyle.paragraph,
        required=True,
        max_length=2000
    )

    def __init__(self, webhook_url: str, message_id: int):
        super().__init__()
        self.webhook_url = webhook_url
        self.message_id = message_id

    async def on_submit(self, interaction: discord.Interaction):
        try:
            webhook = discord.Webhook.from_url(self.webhook_url, session=bot.http._HTTPClient__session)
            await webhook.edit_message(self.message_id, content=self.message_content.value)
            await interaction.response.send_message("メッセージを編集しました。", ephemeral=True)
        except Exception as e:
            await interaction.response.send_message(f"編集中にエラーが発生しました: {e}", ephemeral=True)

class PunishConfirmModal(discord.ui.Modal, title='<:11:1407591910767464459> 処罰の確認'):
    confirm_text = discord.ui.TextInput(
        label='本当に処罰しますか？',
        style=discord.TextStyle.short,
        placeholder='「はい」と入力してください',
        required=True
    )

    def __init__(self, user_id: str, content: str):
        super().__init__()
        self.user_id = user_id
        self.content = content

    async def on_submit(self, interaction: discord.Interaction):
        if self.confirm_text.value.lower() != "はい":
            await interaction.response.send_message("キャンセルしました。", ephemeral=True)
            return
        view = PunishConfirmView(self.user_id, self.content)
        await interaction.response.send_message("最終確認：本当に処罰しますか？", view=view, ephemeral=True)


class PunishConfirmView(discord.ui.View):
    def __init__(self, user_id: str, content: str):
        super().__init__(timeout=300)
        self.user_id = user_id
        self.content = content

    @discord.ui.button(label="はい", style=discord.ButtonStyle.danger)
    async def confirm_punish(self, interaction: discord.Interaction, button: discord.ui.Button):
        global banned_users
        banned_users = load_json(BANNED_USERS_FILE, {})
        banned_users[self.user_id] = {"reason": "ルール違反", "message_content": self.content}
        save_json(BANNED_USERS_FILE, banned_users)

        try:
            user = await bot.fetch_user(int(self.user_id))
            embed = discord.Embed(
                title="<:12:1407591937728577599> 匿名チャット利用制限",
                description="ルール違反のため、匿名チャットの利用が制限されました。",
                color=discord.Color.red()
            )
            embed.add_field(name="違反メッセージ", value=f"```{self.content[:1000]}```", inline=False)
            await user.send(embed=embed)
        except Exception as e:
            print(f"DM送信エラー: {e}")

        embed = interaction.message.embeds[0]
        embed.description = (embed.description or "") + "\n**終了済み**"
        await interaction.message.edit(embed=embed, view=None)

        await interaction.response.send_message("処罰を実行しました。", ephemeral=True)
        self.stop()

    @discord.ui.button(label="キャンセル", style=discord.ButtonStyle.secondary)
    async def cancel_punish(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_message("キャンセルしました。", ephemeral=True)
        self.stop()

class ReportView(discord.ui.View):
    def __init__(self, user_id: str, content: str, message: discord.Message):
        super().__init__(timeout=None)
        self.user_id = user_id
        self.content = content
        self.message = message

    @discord.ui.button(label="処罰", style=discord.ButtonStyle.danger, custom_id="punish_button")
    async def punish_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(PunishConfirmModal(self.user_id, self.content))

    @discord.ui.button(label="処罰なし", style=discord.ButtonStyle.primary, custom_id="no_punish_button")
    async def no_punish_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        embed = interaction.message.embeds[0]
        embed.description = (embed.description or "") + "\n**終了済み**"
        await interaction.message.edit(embed=embed, view=None)
        await interaction.response.send_message("処罰なしで処理を終了しました。", ephemeral=True)

    @discord.ui.button(label="メッセージを確認", style=discord.ButtonStyle.secondary, custom_id="view_message_button")
    async def view_message_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_message(f"メッセージリンク: {self.message.jump_url}", ephemeral=True)

class HelpView(discord.ui.View):
    def __init__(self, channel_id: str):
        super().__init__(timeout=None)
        self.channel_id = channel_id

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
            "### なお、この処罰は全て匿名で行います。\n"
            "-# 詳細情報 : https://github.com/y-exe/tokumei-bot/blob/main/TERMS_OF_SERVICE.md\n"
            "-# <:5_:1407591193751195698> また、本規約は変更される可能性があります"
        )
        embed.set_image(url="https://i.gyazo.com/4f2b4b2c8834431cfe74d87ff795e9e2.png")
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @discord.ui.button(label="2", style=discord.ButtonStyle.secondary, emoji="2️⃣", custom_id="help_2")
    async def help_2(self, interaction: discord.Interaction, button: discord.ui.Button):
        channel_data = anonymous_channels_data.get(self.channel_id, {})
        log_enabled = channel_data.get("logging_enabled", True)
        embed = discord.Embed(title="<a:1_:1401169042936692776> プライバシーポリシー", color=discord.Color.blue())
        if log_enabled:
            embed.description = (
                "### 匿名チャットのログ保存・利用につきまして\n"
                "<:10:1407591891318472794> このチャンネルではログ保存が`ON`になっています\n"
                "この場合、利用規約に違反するメッセージがあった場合運営が\n"
                "**直接処罰することがあります** (詳しくは利用規約)\n\n"
                "<:11:1407591910767464459> ただ、5日以上たったメッセージはアーカイブ化します\n"
                "この場合、通報しても自動削除対応のみの対応となります\n\n"
                "-# 詳細情報  :  https://github.com/y-exe/tokumei-bot/blob/main/PRIVACY_POLICY.md\n"
                "-# <:5_:1407591193751195698> また、本ポリシーは変更される可能性があります"
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
            "**<:10:1407591891318472794> メッセージをPCの場合は右クリック、スマホなどの場合は長押しをして\n"
            "アプリからメッセージ通報を押すことで\n"
            "メッセージの通報が可能です。**"
        )
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @discord.ui.button(label="4", style=discord.ButtonStyle.secondary, emoji="4️⃣", custom_id="help_4")
    async def help_4(self, interaction: discord.Interaction, button: discord.ui.Button):
        embed = discord.Embed(title="<:9_:1407591872234520576> メッセージ削除・編集について", color=discord.Color.blue())
        embed.description = (
            "**<:10:1407591891318472794> メッセージをPCの場合は右クリック、スマホなどの場合は長押しをして\n"
            "アプリからメッセージ削除・またはメッセージを編集を押すことで\n"
            "指定の動作が可能です**\n"
            "-# <:5_:1407591193751195698> ※ただし、削除しても事前に通報された場合メッセージ内容は残ります"
        )
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @discord.ui.button(label="5", style=discord.ButtonStyle.secondary, emoji="5️⃣", custom_id="help_5")
    async def help_5(self, interaction: discord.Interaction, button: discord.ui.Button):
        embed = discord.Embed(title="<:9_:1407591872234520576> その他詳細", color=discord.Color.blue())
        embed.description = (
            "<:10:1407591891318472794> **このBotはWebhookを使い匿名チャットを再現するものです**\n"
            "匿名の性質上荒れることが多いため、\n"
            "`動画のブロック` `画像のNSFW・グロ検知` `キーワード、ドメインブロック`\nを導入しています。\n"
            "またログが`ON`になっているチャンネルでは**通報機能**を実装しています。\n\n"
            "<:3_:1407591152491827211> また、荒れすぎた場合\n"
            "**ルール改正や処罰、検閲体制の変更、サ終を検討することもあります。**\n"
            "### <:11:1407591910767464459> 基本フリーですが限度を守ってご利用ください\n"
            "https://github.com/y-exe/tokumei-bot\n"
            "作成者 <@703734573108035715\n\n>"
            "**メッセージは必ずボタンからメッセージを送信してください!!**"
        )
        embed.set_image(url="https://i.gyazo.com/ae166f68498a505e4c9db341f8c8f652.png")
        await interaction.response.send_message(embed=embed, ephemeral=True)

class AnonymousPostView(discord.ui.View):
    def __init__(self, channel_id: str):
        super().__init__(timeout=None)
        self.channel_id = channel_id

    @discord.ui.button(label='クリックして匿名で送信', style=discord.ButtonStyle.primary, emoji='✍️', custom_id='anonymous_post_button')
    async def post_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        try:
            await interaction.response.send_modal(AnonymousPostModal())
        except discord.errors.NotFound as e:
            print(f"モーダル送信時にインタラクションが見つかりませんでした: {e}")

    @discord.ui.button(label='ヘルプ・詳細', style=discord.ButtonStyle.secondary, custom_id='help_button')
    async def help_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        embed = discord.Embed(title="ヘルプ・詳細", color=discord.Color.blue())
        embed.description = (
            "**1️⃣ : 利用規約(ルール)\n"
            "2️⃣ : プライバシーポリシー(ログ保存等)\n"
            "3️⃣ : メッセージ通報について\n"
            "4️⃣ : メッセージ削除、メッセージ編集について\n"
            "5️⃣ : その他詳細**"
        )
        await interaction.response.send_message(embed=embed, view=HelpView(self.channel_id), ephemeral=True)

class ReportConfirmView(discord.ui.View):
    def __init__(self, original_interaction: discord.Interaction, message: discord.Message):
        super().__init__(timeout=60)
        self.original_interaction = original_interaction
        self.message = message

    @discord.ui.button(label="はい", style=discord.ButtonStyle.danger)
    async def confirm_report(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.defer(ephemeral=True)
        response_message = await process_report(self.original_interaction, self.message)
        await interaction.followup.send(response_message, ephemeral=True)
        self.stop()

    @discord.ui.button(label="キャンセル", style=discord.ButtonStyle.secondary)
    async def cancel_report(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.edit_message(content="通報をキャンセルしました。", view=None, embed=None)
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
        if not is_authorized(interaction):
            await interaction.response.send_message("この操作を行う権限がありません。", ephemeral=True)
            return
        
        banned_users = load_json(BANNED_USERS_FILE, {})
        
        if self.is_banned:
            if self.target_user_id in banned_users:
                del banned_users[self.target_user_id]
                save_json(BANNED_USERS_FILE, banned_users)
                result_text = "BANを解除しました。"
                self.is_banned = False
            else:
                result_text = "このユーザーは既にBANされていませんでした。"
        else:
            if self.target_user_id not in banned_users:
                banned_users[self.target_user_id] = {"reason": "手動によるBAN", "message_content": "N/A"}
                save_json(BANNED_USERS_FILE, banned_users)
                result_text = "BANを付与しました。"
                self.is_banned = True
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
        await self.interaction.edit_original_response(view=self)

async def update_button_message(channel: discord.TextChannel, channel_id: str):
    global anonymous_channels_data, button_update_locks
    lock = button_update_locks.setdefault(channel.id, asyncio.Lock())
    async with lock:
        channel_data = anonymous_channels_data.get(channel_id, {})
        if old_msg_id := channel_data.get("button_message_id"):
            try:
                old_msg = await channel.fetch_message(old_msg_id)
                await old_msg.delete()
            except (discord.NotFound, discord.Forbidden):
                pass
        try:
            title_text = "<a:1_:1401169042936692776>匿名つぶやき"
            description_text = (
                "<a:2_:1401169059235762208>匿名でメッセージを送信できます\n"
                "ルールや詳細な利用方法などはヘルプ・詳細から確認してください \n"
                "**必ずボタンからメッセージを送信してください!!**"
            )
            embed = discord.Embed(title=title_text, description=description_text, color=discord.Color.dark_theme())
            new_msg = await channel.send(embed=embed, view=AnonymousPostView(channel_id))
            if channel_id not in anonymous_channels_data:
                anonymous_channels_data[channel_id] = {}
            anonymous_channels_data[channel_id]["button_message_id"] = new_msg.id
            save_json(CHANNELS_FILE, anonymous_channels_data)
        except discord.Forbidden:
            print(f"エラー: チャンネル {channel.name} ({channel.id}) にメッセージを送信する権限がありません。")


@bot.tree.context_menu(name="メッセージを編集")
async def edit_message(interaction: discord.Interaction, message: discord.Message):
    log_entry = None
    for i in range(6): 
        check_date = datetime.now(timezone.utc) - timedelta(days=i)
        log_file = get_log_file_path(check_date)
        if os.path.exists(log_file):
            message_log = load_json(log_file, {})
            if str(message.id) in message_log:
                log_entry = message_log.get(str(message.id))
                break
    
    if not log_entry:
        await interaction.response.send_message("このメッセージの記録が見つかりませんでした。投稿から5日以上経過している可能性があります。", ephemeral=True)
        return
    if str(interaction.user.id) != log_entry.get("user_id"):
        await interaction.response.send_message("これはあなたが送信したメッセージではありません。", ephemeral=True)
        return
        
    modal = EditMessageModal(webhook_url=log_entry["webhook_url"], message_id=message.id)
    modal.message_content.default = message.content
    await interaction.response.send_modal(modal)

@bot.tree.context_menu(name="メッセージを削除")
async def delete_message(interaction: discord.Interaction, message: discord.Message):
    log_entry = None
    log_file_path = None
    for i in range(6):
        check_date = datetime.now(timezone.utc) - timedelta(days=i)
        log_file = get_log_file_path(check_date)
        if os.path.exists(log_file):
            message_log = load_json(log_file, {})
            if str(message.id) in message_log:
                log_entry = message_log.get(str(message.id))
                log_file_path = log_file
                break

    if not log_entry:
        await interaction.response.send_message("このメッセージの記録が見つかりませんでした。投稿から5日以上経過している可能性があります。", ephemeral=True)
        return
    if str(interaction.user.id) != log_entry.get("user_id"):
        await interaction.response.send_message("これはあなたが送信したメッセージではありません。", ephemeral=True)
        return
        
    try:
        webhook = discord.Webhook.from_url(log_entry["webhook_url"], session=bot.http._HTTPClient__session)
        await webhook.delete_message(message.id)
        
        embed = discord.Embed(title="メッセージを削除しました。", color=discord.Color.green())
        await interaction.response.send_message(embed=embed, ephemeral=True)
        
        if log_file_path:
            message_log = load_json(log_file_path, {})
            if str(message.id) in message_log:
                del message_log[str(message.id)]
                save_json(log_file_path, message_log)
    except Exception as e:
        await interaction.response.send_message(f"削除中にエラーが発生しました: {e}", ephemeral=True)

@bot.tree.context_menu(name="匿名つぶやき通報")
async def report_message(interaction: discord.Interaction, message: discord.Message):
    if message.webhook_id is None:
        await interaction.response.send_message("匿名メッセージ（Webhookからの投稿）のみ通報できます。", ephemeral=True)
        return

    embed = discord.Embed(title="このメッセージを通報しますか？", color=discord.Color.orange())
    embed.add_field(name="メッセージ内容", value=f"```{message.content[:1000]}```", inline=False)
    await interaction.response.send_message(embed=embed, view=ReportConfirmView(interaction, message), ephemeral=True)


async def process_report(interaction: discord.Interaction, message: discord.Message) -> str:
    global report_data, anonymous_channels_data, guild_settings

    channel_id = str(interaction.channel.id)
    if not anonymous_channels_data.get(channel_id, {}).get("logging_enabled", False):
        return "このチャンネルではログ保存がOFFのため、通報は無効です。"

    log_entry = None
    for i in range(6): 
        check_date = datetime.now(timezone.utc) - timedelta(days=i)
        log_file = get_log_file_path(check_date)
        if os.path.exists(log_file):
            message_log = load_json(log_file, {})
            if str(message.id) in message_log:
                log_entry = message_log.get(str(message.id))
                break
    
    if not log_entry:
        archive_file = 'logs/archive.json'
        archive_data = load_json(archive_file, {})
        if str(message.id) in archive_data:
            try:
                webhook_url = archive_data[str(message.id)]["webhook_url"]
                webhook = discord.Webhook.from_url(webhook_url, session=bot.http._HTTPClient__session)
                await webhook.delete_message(message.id)
                del archive_data[str(message.id)]
                save_json(archive_file, archive_data)
                return "5日以上前のメッセージのため、通報できません。メッセージは自動的に削除されました。"
            except Exception as e:
                print(f"アーカイブメッセージ削除エラー: {e}")
                return "5日以上前のメッセージのため、通報できませんでした。"
        return "通報対象のメッセージ情報が見つかりませんでした。ログが記録されていないか、古いメッセージの可能性があります。"

    reporter_id = str(interaction.user.id)
    message_id_str = str(message.id)

    current_report = report_data.setdefault(message_id_str, {"reporters": [], "log_message_id": None})
    
    if reporter_id in current_report["reporters"]:
        return "あなたはこのメッセージを既に通報済みです。"
    
    current_report["reporters"].append(reporter_id)
    
    guild_id = str(interaction.guild.id)
    guild_data = guild_settings.get(guild_id, {})
    report_channel_id = guild_data.get("report_channel_id")
    
    if not report_channel_id:
        return "通報を受け付けましたが、サーバーのレポートチャンネルが設定されていません。"
    
    report_channel = bot.get_channel(int(report_channel_id))
    if not report_channel:
        return "通報を受け付けましたが、指定されたレポートチャンネルが見つかりません。"

    thresholds = load_json(THRESHOLDS_FILE, DEFAULT_THRESHOLDS)
    report_threshold = thresholds.get("report", 3)

    try:
        sender = await bot.fetch_user(int(log_entry["user_id"]))
        
        embed = discord.Embed(title="<:3_:1407591152491827211> 匿名メッセージの通報", color=discord.Color.red())
        embed.add_field(
            name="メッセージの情報",
            value=(
                f"**<:4_:1407591175275286628> 送信者**: {sender.mention} [`{sender.id}`]\n"
                f"**<:6_:1407591216459153460> 送信時刻**: <t:{int(message.created_at.timestamp())}:F>\n"
                f"**<:5_:1407591193751195698> 送信内容**: ```{discord.utils.escape_markdown(message.content)[:1000]}```"
            ),
            inline=False
        )
        embed.add_field(name="<:8_:1407591279243825162> 報告人数", value=f"{len(current_report['reporters'])}人", inline=False)
        embed.add_field(name="<:7_:1407591242656911391> 報告者", value=" ".join(f"<@{uid}>" for uid in current_report['reporters']), inline=False)
        if sender:
            embed.set_thumbnail(url=sender.display_avatar.url)

        if current_report["log_message_id"]: 
            log_message = await report_channel.fetch_message(current_report["log_message_id"])
            await log_message.edit(embed=embed)
            return "通報を更新しました。"
        
        else: 
            if len(current_report["reporters"]) >= report_threshold:
                sent_message = await report_channel.send(embed=embed, view=ReportView(log_entry["user_id"], message.content, message))
                current_report["log_message_id"] = sent_message.id
                return "規定数の通報があったため、管理者に通知しました。"
            else:
                return f"通報を受け付けました。 (現在 {len(current_report['reporters'])}/{report_threshold} 件)"

    except Exception as e:
        print(f"通報処理エラー: {e}")
        return f"通報処理中に予期せぬエラーが発生しました。"


@bot.tree.command(name="id", description="匿名メッセージの投稿者IDを特定します。")
@app_commands.describe(message="メッセージIDまたはメッセージのURL")
@app_commands.check(is_authorized)
async def id_lookup(interaction: discord.Interaction, message: str):
    await interaction.response.defer(ephemeral=True)
    matches = re.findall(r'(\d{18,})', message)
    if not matches:
        await interaction.followup.send("有効なメッセージIDまたはURLを指定してください。", ephemeral=True)
        return
    message_id = matches[-1]
    
    log_entry = None
    for i in range(6):
        check_date = datetime.now(timezone.utc) - timedelta(days=i)
        log_file = get_log_file_path(check_date)
        if os.path.exists(log_file):
            message_log = load_json(log_file, {})
            if message_id in message_log:
                log_entry = message_log.get(message_id)
                break
    if not log_entry:
        archive_file = 'logs/archive.json'
        archive_data = load_json(archive_file, {})
        log_entry = archive_data.get(message_id)

    if not log_entry:
        await interaction.followup.send("指定されたメッセージの投稿者情報が見つかりませんでした。", ephemeral=True)
        return

    sender_id = log_entry.get("user_id")
    try:
        sender = await bot.fetch_user(int(sender_id))
        original_message = None
        for channel in interaction.guild.text_channels:
            try:
                original_message = await channel.fetch_message(int(message_id))
                break
            except (discord.NotFound, discord.Forbidden):
                continue
        if not original_message:
            await interaction.followup.send("指定されたメッセージをサーバー内で見つけることができませんでした。", ephemeral=True)
            return
        embed = discord.Embed(title="送信者情報", color=discord.Color.blue())
        if sender:
            embed.set_thumbnail(url=sender.display_avatar.url)
            embed.add_field(name="送信者", value=f"{sender.mention} [`{sender.id}`]", inline=False)
        else:
            embed.add_field(name="送信者", value=f"不明なユーザー {sender_id}", inline=False)
        embed.add_field(name="メッセージID", value=f"{original_message.id}", inline=False)
        embed.add_field(name="送信時間", value=f"<t:{int(original_message.created_at.timestamp())}:F>", inline=False)
        if original_message.content:
            embed.add_field(name="メッセージ内容", value=f"```{discord.utils.escape_markdown(original_message.content)}```", inline=False)
        await interaction.followup.send(embed=embed, ephemeral=True)
    except Exception as e:
        await interaction.followup.send(f"情報の取得中にエラーが発生しました: {e}", ephemeral=True)

@id_lookup.error
async def id_lookup_error(interaction: discord.Interaction, error: app_commands.AppCommandError):
    if isinstance(error, app_commands.CheckFailure):
        await interaction.response.send_message("このコマンドを実行する権限がありません。", ephemeral=True)
    else:
        await interaction.response.send_message(f"コマンド実行中にエラーが発生しました: {error}", ephemeral=True)

@bot.tree.command(name="state", description="ユーザーの状態を確認・変更します。")
@app_commands.describe(user_id="状態を確認するユーザーのID")
@app_commands.check(is_authorized)
async def state(interaction: discord.Interaction, user_id: str):
    await interaction.response.defer(ephemeral=True)
    
    try:
        target_user = await bot.fetch_user(int(user_id))
    except (discord.NotFound, ValueError):
        await interaction.followup.send("指定されたIDのユーザーが見つかりませんでした。", ephemeral=True)
        return

    banned_users = load_json(BANNED_USERS_FILE, {})
    is_banned = user_id in banned_users

    embed = discord.Embed(title="ユーザー状態", color=discord.Color.red() if is_banned else discord.Color.green())
    embed.set_thumbnail(url=target_user.display_avatar.url)
    embed.add_field(name="ユーザー", value=f"{target_user.mention} (`{user_id}`)", inline=False)
    
    if is_banned:
        reason = banned_users[user_id].get('reason', '理由なし')
        embed.add_field(name="状態", value="<:12:1407591937728577599> **BANされています**", inline=False)
        embed.add_field(name="理由", value=reason, inline=False)
    else:
        embed.add_field(name="状態", value="<:10:1407591891318472794> **正常です**", inline=False)
        
    view = UserStateView(target_user_id=user_id, is_banned=is_banned, interaction=interaction)
    await interaction.followup.send(embed=embed, view=view, ephemeral=True)

@state.error
async def state_error(interaction: discord.Interaction, error: app_commands.AppCommandError):
    if isinstance(error, app_commands.CheckFailure):
        await interaction.response.send_message("このコマンドを実行する権限がありません。", ephemeral=True)
    else:
        await interaction.response.send_message(f"コマンド実行中にエラーが発生しました: {error}", ephemeral=True)


@bot.tree.command(name="border", description="モデレーションの境界値を設定します。")
@app_commands.check(is_authorized)
@app_commands.describe(
    action="実行するアクション",
    category="対象カテゴリ",
    value="設定する値 (数値または文字列)"
)
@app_commands.choices(action=[
    discord.app_commands.Choice(name="set", value="set"),
    discord.app_commands.Choice(name="add", value="add"),
    discord.app_commands.Choice(name="remove", value="remove")
])
@app_commands.choices(category=[
    discord.app_commands.Choice(name="nsfw", value="nsfw"),
    discord.app_commands.Choice(name="guro", value="guro"),
    discord.app_commands.Choice(name="report", value="report"),
    discord.app_commands.Choice(name="url", value="domains"),
    discord.app_commands.Choice(name="keyword", value="keywords")
])
async def border(interaction: discord.Interaction, action: str, category: str, value: str):
    if action == "set":
        try:
            val = float(value)
            if category in ["nsfw", "guro"] and not (0.01 <= val <= 1.0):
                await interaction.response.send_message("NSFWまたはGuroの値は 0.01 から 1.0 の間で設定してください。", ephemeral=True)
                return
            if category == "report":
                val = int(val)
                if not (1 <= val <= 10):
                    await interaction.response.send_message("Reportの値は 1 から 10 の間で設定してください。", ephemeral=True)
                    return
            settings = load_json(THRESHOLDS_FILE, DEFAULT_THRESHOLDS)
            settings[category] = val
            save_json(THRESHOLDS_FILE, settings)
            await interaction.response.send_message(f"{category}のしきい値を{value}に設定しました。", ephemeral=True)
        except ValueError:
            await interaction.response.send_message("数値を入力してください。", ephemeral=True)
    elif action in ["add", "remove"]:
        filename = DOMAINS_FILE if category == "domains" else KEYWORDS_FILE if category == "keywords" else None
        if not filename:
            await interaction.response.send_message("無効なカテゴリです。", ephemeral=True)
            return
        default_data = DEFAULT_DOMAINS if category == "domains" else DEFAULT_KEYWORDS
        settings = load_json(filename, default_data)
        if action == "add":
            if value.lower() not in settings:
                settings.append(value.lower())
                save_json(filename, settings)
                await interaction.response.send_message(f"`{category}`リストに`{value}`を追加しました。", ephemeral=True)
            else:
                await interaction.response.send_message(f"`{value}`は既にリストに存在します。", ephemeral=True)
        else:
            if value.lower() in settings:
                settings.remove(value.lower())
                save_json(filename, settings)
                await interaction.response.send_message(f"`{category}`リストから`{value}`を削除しました。", ephemeral=True)
            else:
                await interaction.response.send_message(f"`{value}`はリストに存在しません。", ephemeral=True)

@border.error
async def border_error(interaction: discord.Interaction, error: app_commands.AppCommandError):
    if isinstance(error, app_commands.CheckFailure):
        await interaction.response.send_message("このコマンドを実行する権限がありません。", ephemeral=True)
    else:
        await interaction.response.send_message(f"コマンド実行中にエラーが発生しました: {error}", ephemeral=True)

log_group = app_commands.Group(name="log", description="ログ関連の設定")

@log_group.command(name="switch", description="匿名チャンネルのログ保存をON/OFFにします。")
@app_commands.check(is_authorized)
@app_commands.describe(state="ログ保存の状態")
@app_commands.choices(state=[
    discord.app_commands.Choice(name="ON", value="on"),
    discord.app_commands.Choice(name="OFF", value="off")
])
async def log_toggle(interaction: discord.Interaction, state: str):
    global anonymous_channels_data 
    channel_id = str(interaction.channel.id)
    
    if channel_id not in anonymous_channels_data:
        await interaction.response.send_message("このチャンネルは匿名チャット用に設定されていません。", ephemeral=True)
        return
    
    is_on = (state.lower() == "on")
    anonymous_channels_data[channel_id]["logging_enabled"] = is_on
    save_json(CHANNELS_FILE, anonymous_channels_data) 
    
    status_text = "ON" if is_on else "OFF"
    message = f"ログ保存を **{status_text}** に設定しました。"
    if not is_on:
        message += "\n今後このチャンネルのメッセージは通報・追跡できなくなります。"
        
    await interaction.response.send_message(message, ephemeral=True)


@log_group.command(name="channel", description="ログを送るチャンネルを設定します。")
@app_commands.check(is_authorized)
@app_commands.describe(channel="通報ログを送信するチャンネル")
async def log_channel(interaction: discord.Interaction, channel: discord.TextChannel):
    global guild_settings
    guild_id = str(interaction.guild.id)
    
    if guild_id not in guild_settings:
        guild_settings[guild_id] = {}
        
    guild_settings[guild_id]["report_channel_id"] = str(channel.id)
    save_json(GUILD_SETTINGS_FILE, guild_settings)
    await interaction.response.send_message(f"ログチャンネルを {channel.mention} に設定しました。", ephemeral=True)


bot.tree.add_command(log_group)

@log_toggle.error
async def log_toggle_error(interaction: discord.Interaction, error: app_commands.AppCommandError):
    if isinstance(error, app_commands.CheckFailure):
        await interaction.response.send_message("このコマンドを実行する権限がありません。", ephemeral=True)
    else:
        await interaction.response.send_message(f"コマンド実行中にエラーが発生しました: {error}", ephemeral=True)


@bot.event
async def on_message(message: discord.Message):
    if message.author.bot:
        return
        
    channel_id = str(message.channel.id)
    if channel_id in anonymous_channels_data:
        if message.author.id in ALLOWED_USER_IDS or any(role.id == ALLOWED_ROLE_ID for role in getattr(message.author, 'roles', [])):
            await bot.process_commands(message)
            return

        try:
            await message.delete()
            embed = discord.Embed(title="メッセージを削除しました", color=discord.Color.red())
            embed.description = (
                "匿名チャンネルでは、通常のメッセージ送信はできません。\n"
                "必ずボタンからメッセージを送信してください。"
            )
            embed.add_field(name="送信しようとしたメッセージ", value=f"```{message.content[:1000]}```", inline=False)
            embed.set_image(url="https://i.gyazo.com/ae166f68498a505e4c9db341f8c8f652.png")
            await message.author.send(embed=embed)
        except discord.Forbidden:
            print(f"メッセージ削除失敗: チャンネル {message.channel.name} で権限がありません。")
        except discord.NotFound:
            pass
        except Exception as e:
            print(f"メッセージ削除中に予期せぬエラー: {e}")

    await bot.process_commands(message)

@bot.event
async def on_ready():
    global anonymous_channels_data
    print(f'{bot.user}としてログインしました')
    print('------')
    
    try:
        synced = await bot.tree.sync()
        print(f"{len(synced)}個のコマンドを同期しました。")
    except Exception as e:
        print(f"コマンドの同期に失敗しました: {e}")
        
    for channel_id in anonymous_channels_data:
        bot.add_view(AnonymousPostView(str(channel_id)))
    print("匿名投稿用ボタンをリスンしています。")
    
    if not sightengine_client:
        print("警告: SightengineのAPIキーが設定されていません。画像フィルタリングは無効です。")
        
    archive_old_logs()
    
    anonymous_channels_data = load_json(CHANNELS_FILE, {})
    for channel_id, data in list(anonymous_channels_data.items()):
        channel = bot.get_channel(int(channel_id))
        if channel:
            if "logging_enabled" not in data:
                anonymous_channels_data[channel_id]["logging_enabled"] = True
            await update_button_message(channel, channel_id)
        else:
            print(f"チャンネル {channel_id} が見つかりませんでした。設定をスキップします。")
            
    save_json(CHANNELS_FILE, anonymous_channels_data)

@bot.command(name="sync-t")
@commands.check(lambda ctx: ctx.author.id in ALLOWED_USER_IDS)
async def sync_tree(ctx: commands.Context):
    await ctx.send("アプリケーションコマンドをグローバルに同期しています...反映まで最大1時間かかる場合があります。")
    try:
        synced = await bot.tree.sync()
        await ctx.send(f"{len(synced)}個のコマンドを同期しました。")
        print(f"{len(synced)}個のコマンドを同期しました。")
    except Exception as e:
        await ctx.send(f"コマンドの同期に失敗しました: {e}")
        print(f"コマンドの同期に失敗しました: {e}")

@sync_tree.error
async def sync_tree_error(ctx: commands.Context, error):
    if isinstance(error, commands.CheckFailure):
        await ctx.send("このコマンドを実行する権限がありません。")

@bot.command()
@commands.has_permissions(manage_channels=True)
async def setanonymous(ctx):
    global anonymous_channels_data
    channel_id = str(ctx.channel.id)
    
    if channel_id in anonymous_channels_data:
        await ctx.send("設定を解除しています...")
        channel_data = anonymous_channels_data.get(channel_id, {})
        if webhook_urls := channel_data.get("webhook_urls"):
            for url in webhook_urls:
                try:
                    webhook = discord.Webhook.from_url(url, session=bot.http._HTTPClient__session)
                    await webhook.delete()
                except (discord.NotFound, discord.Forbidden, ValueError):
                    pass
        if button_msg_id := channel_data.get("button_message_id"):
            try:
                msg = await ctx.channel.fetch_message(button_msg_id)
                await msg.delete()
            except (discord.NotFound, discord.Forbidden):
                pass
        del anonymous_channels_data[channel_id]
        save_json(CHANNELS_FILE, anonymous_channels_data)
        await ctx.send("このチャンネルの匿名チャット設定を解除しました。")
    else:
        try:
            await ctx.send(f"Webhookを{WEBHOOK_POOL_SIZE}個、固定アイコンで作成します...")
            webhook_urls = []
            async with aiohttp.ClientSession() as session:
                for i in range(WEBHOOK_POOL_SIZE):
                    icon_url = AVATAR_URLS[i % len(AVATAR_URLS)]
                    avatar_bytes = None
                    try:
                        async with session.get(icon_url) as resp:
                            if resp.status == 200:
                                avatar_bytes = await resp.read()
                    except Exception as e:
                        print(f"アイコンのダウンロードに失敗しました: {e}")
                    webhook = await ctx.channel.create_webhook(name=f"匿名", avatar=avatar_bytes)
                    webhook_urls.append(webhook.url)
            anonymous_channels_data[channel_id] = {
                "webhook_urls": webhook_urls,
                "last_webhook_url_used": None,
                "button_message_id": None,
                "logging_enabled": True
            }
            save_json(CHANNELS_FILE, anonymous_channels_data)
            await ctx.send(f"{ctx.channel.mention} を匿名チャット用に設定しました。")
            await update_button_message(ctx.channel, channel_id)
        except discord.Forbidden:
            await ctx.send("エラー: BotにWebhookを作成する権限がありません。")
        except Exception as e:
            await ctx.send(f"設定中にエラーが発生しました: {e}")

@setanonymous.error
async def setanonymous_error(ctx, error):
    if isinstance(error, commands.MissingPermissions):
        await ctx.send("このコマンドを使用するには、チャンネルの管理権限が必要です。")


if __name__ == "__main__":
    TOKEN = os.getenv("DISCORD_BOT_TOKEN")
    if not TOKEN:
        print("エラー: .envファイルに DISCORD_BOT_TOKEN が設定されていません。")
    else:
        bot.run(TOKEN)
