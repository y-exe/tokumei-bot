import discord
import os
import random
import asyncio
from datetime import datetime, timezone, timedelta
from models.constants import *
from utils.json_helper import load_json, save_json
from utils.logging_helper import get_log_file_path

async def check_ban(interaction: discord.Interaction):
    user_id_str = str(interaction.user.id)
    banned_users = load_json(BANNED_USERS_FILE, {})
    if user_id_str not in banned_users:
        return False

    user_ban_info = banned_users[user_id_str]
    expires_at_str = user_ban_info.get("expires_at")
    
    if expires_at_str:
        try:
            expires_at = datetime.fromisoformat(expires_at_str)
            if datetime.now() > expires_at:
                del banned_users[user_id_str]
                save_json(BANNED_USERS_FILE, banned_users)
                return False
            else:
                embed = discord.Embed(
                    title="投稿エラー", 
                    description=f"規定のルール違反により、匿名チャットの利用が制限されています。\n**解除予定時刻**: <t:{int(expires_at.timestamp())}:F>", 
                    color=discord.Color.red()
                )
                if interaction.response.is_done():
                    await interaction.followup.send(embed=embed, ephemeral=True)
                else:
                    await interaction.response.send_message(embed=embed, ephemeral=True)
                return True
        except ValueError:
            pass
    
    embed = discord.Embed(title="投稿エラー", description="ルール違反のため、匿名チャットの利用制限（永久）が課されています。", color=discord.Color.red())
    if interaction.response.is_done():
        await interaction.followup.send(embed=embed, ephemeral=True)
    else:
        await interaction.response.send_message(embed=embed, ephemeral=True)
    return True

async def send_anonymous_message(bot, interaction: discord.Interaction, content: str, anonymous_channels_data, attachment=None):
    channel_id = str(interaction.channel.id)
    channel_data = anonymous_channels_data.get(channel_id)
    if not channel_data or not channel_data.get("webhook_url"):
        print(f"エラー: チャンネル {channel_id} のWebhook設定が見つかりません。")
        return False

    user_id = str(interaction.user.id)
    current_time = datetime.now(timezone.utc)
    
    user_post_data = load_json(USER_DATA_FILE, {})
    anonymous_data = load_json(ANONYMOUS_DATA_FILE, {})
    channel_anon_data = anonymous_data.setdefault(channel_id, {"counter": 0, "last_icon": None, "last_user_id": None})

    if channel_anon_data["counter"] >= 1000:
        channel_anon_data["counter"] = 0
        embed = discord.Embed(
            title="匿名IDがリセットされました。",
            description="IDは001からになります。",
            color=discord.Color.blue()
        )
        await interaction.channel.send(embed=embed)
        for uid, data in user_post_data.items():
            if channel_id in data:
                del user_post_data[uid][channel_id]
        save_json(USER_DATA_FILE, user_post_data)

    anonymous_id = None
    avatar_url = None
    should_inherit = False
    last_poster = channel_anon_data.get("last_user_id")
    if user_id in user_post_data and channel_id in user_post_data[user_id] and last_poster == user_id:
        user_channel_data = user_post_data[user_id][channel_id]
        last_post_time = datetime.fromisoformat(user_channel_data["timestamp"])
        if current_time - last_post_time < timedelta(minutes=CONTINUOUS_POST_THRESHOLD_MINUTES):
            should_inherit = True
            anonymous_id = user_channel_data.get("anonymous_id")
            avatar_url = user_channel_data.get("avatar_url")
    
    if not should_inherit:
        channel_anon_data["counter"] += 1
        anonymous_id = channel_anon_data["counter"]
        last_icon = channel_anon_data.get("last_icon")
        available_avatars = [url for url in AVATAR_URLS if url != last_icon]
        if not available_avatars:
            available_avatars = AVATAR_URLS
        avatar_url = random.choice(available_avatars)
        channel_anon_data["last_icon"] = avatar_url

    try:
        webhook_url = channel_data["webhook_url"]
        webhook = discord.Webhook.from_url(webhook_url, session=bot.http._HTTPClient__session)
        
        files = []
        if attachment:
            files.append(await attachment.to_file())

        channel_type = channel_data.get("channel_type", "normal")
        username = "匿名" if channel_type == "request" else f"匿名 {anonymous_id:03d}"

        sent_message = await webhook.send(
            content=content,
            username=username,
            avatar_url=avatar_url,
            allowed_mentions=discord.AllowedMentions.none(),
            files=files,
            wait=True
        )

        if channel_data.get("logging_enabled", True):
            log_file = get_log_file_path(current_time)
            message_log = load_json(log_file, {})
            log_entry = {
                "user_id": user_id, 
                "timestamp": current_time.isoformat(), 
                "content": content
            }
            if sent_message.attachments:
                log_entry["attachment_url"] = sent_message.attachments[0].url
            message_log[str(sent_message.id)] = log_entry
            save_json(log_file, message_log)
        
        message_logs = load_json(MESSAGE_LOGS_FILE, {})
        message_logs[str(sent_message.id)] = {
            "anonymous_id": anonymous_id, "user_id": user_id
        }
        save_json(MESSAGE_LOGS_FILE, message_logs)

        user_post_data.setdefault(user_id, {})[channel_id] = {
            "timestamp": current_time.isoformat(), "anonymous_id": anonymous_id, "avatar_url": avatar_url
        }
        channel_anon_data["last_user_id"] = user_id
        save_json(USER_DATA_FILE, user_post_data)
        save_json(ANONYMOUS_DATA_FILE, anonymous_data)
        
        return True
    except Exception as e:
        print(f"メッセージ送信中にエラー: {e}")
        return False

async def update_button_message(bot, channel: discord.TextChannel, channel_id: str, anonymous_channels_data, button_update_locks, post_view_class):
    lock = button_update_locks.setdefault(channel.id, asyncio.Lock())
    async with lock:
        channel_data = anonymous_channels_data.get(channel_id, {})
        if old_msg_id := channel_data.get("button_message_id"):
            try:
                msg = await channel.fetch_message(old_msg_id)
                await msg.delete()
            except (discord.NotFound, discord.Forbidden): pass
        try:
            channel_type = channel_data.get("channel_type", "normal")
            if channel_type == "request":
                embed = discord.Embed(
                    title="<a:1_:1401169042936692776>匿名要望",
                    description="<a:2_:1401169059235762208>ボタンより匿名で要望・意見を送信できます\n**匿名で出したくない場合は普通にテキストを送信してOKです**\n良識の範囲内でご利用ください",
                    color=discord.Color.dark_theme()
                )
            else:
                embed = discord.Embed(
                    title="<a:1_:1401169042936692776>匿名つぶやき",
                    description="<a:2_:1401169059235762208>匿名でメッセージを送信できます\n<a:13:1499325976411111495>**新ルール : 一個人ユーザーが特定できる__悪口・批判が含まれる内容の投稿を禁止__します。(運営、やまかわ本人、サーバー全体に関することは可)**\nルールや詳細な利用方法などはヘルプ・詳細から確認してください",
                    color=discord.Color.dark_theme()
                )
            new_msg = await channel.send(embed=embed, view=post_view_class(channel_id, mode=channel_type))
            anonymous_channels_data.setdefault(channel_id, {})["button_message_id"] = new_msg.id
            save_json(CHANNELS_FILE, anonymous_channels_data)
        except discord.Forbidden:
            print(f"エラー: チャンネル {channel.name} への送信権限がありません。")

async def process_report(bot, interaction: discord.Interaction, message: discord.Message, anonymous_channels_data, report_data):
    if not anonymous_channels_data.get(str(interaction.channel.id), {}).get("logging_enabled", False):
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
        return "通報対象のメッセージ情報が見つかりませんでした。ログが記録されていないか、古いメッセージの可能性があります。"

    reporter_id = str(interaction.user.id)
    message_id_str = str(message.id)

    guild_settings = load_json(GUILD_SETTINGS_FILE, {})
    current_report = report_data.setdefault(message_id_str, {"reporters": [], "log_message_id": None})
    
    if reporter_id in current_report["reporters"]:
        return "あなたはこのメッセージを既に通報済みです。"
    
    current_report["reporters"].append(reporter_id)
    
    guild_id = str(interaction.guild.id)
    guild_data = guild_settings.get(guild_id, {})
    report_channel_id = guild_data.get("report_channel_id")
    
    if not report_channel_id:
        return "通報を受け付けましたが、サーバーのレポートチャンネルが設定されていません。"
    
    step = "初期化"
    try:
        # ステップ1: チャンネルの特定
        step = f"チャンネル取得 (ID: {report_channel_id})"
        report_channel = bot.get_channel(int(report_channel_id))
        if not report_channel:
            try:
                report_channel = await bot.fetch_channel(int(report_channel_id))
            except discord.NotFound:
                return f"エラー: 指定されたレポートチャンネル(ID: `{report_channel_id}`)が見つかりません。設定をやり直してください。"
            except discord.Forbidden:
                return f"エラー: レポートチャンネル(ID: `{report_channel_id}`)へのアクセス権限(50001)が不足しています。ボットがそのチャンネルを表示できるか確認してください。"

        # ステップ2: ユーザー情報の取得
        step = f"ユーザー情報取得 (User ID: {log_entry.get('user_id')})"
        sender = None
        user_id_str = log_entry.get("user_id")
        if user_id_str:
            try:
                sender = await bot.fetch_user(int(user_id_str))
            except Exception as e:
                print(f"警告: ユーザー({user_id_str})の取得に失敗しました: {e}")

        # ステップ3: Embedの作成
        step = "Embed作成"
        thresholds = load_json(THRESHOLDS_FILE, DEFAULT_THRESHOLDS)
        report_threshold = thresholds.get("report", 3)
        
        embed = discord.Embed(title="<:3_:1407591152491827211> 匿名メッセージの通報", color=discord.Color.red())
        embed.add_field(
            name="メッセージの情報",
            value=(
                f"**<:4_:1407591175275286628> 送信者**: {sender.mention if sender else '不明'} [`{user_id_str if user_id_str else '不明'}`]\n"
                f"**<:6_:1407591216459153460> 送信時刻**: <t:{int(message.created_at.timestamp())}:F>\n"
                f"**<:5_:1407591193751195698> 送信内容**: ```{discord.utils.escape_markdown(message.content)[:1000]}```"
            ),
            inline=False
        )
        embed.add_field(name="<:8_:1407591279243825162> 報告人数", value=f"{len(current_report['reporters'])}人", inline=False)
        embed.add_field(name="<:7_:1407591242656911391> 報告者", value=" ".join(f"<@{uid}>" for uid in current_report['reporters']), inline=False)
        if sender:
            embed.set_thumbnail(url=sender.display_avatar.url)

        from ui.views import ReportView

        # ステップ4: メッセージの送信または更新
        if current_report["log_message_id"]: 
            step = f"既存メッセージ更新 (Msg ID: {current_report['log_message_id']})"
            try:
                log_message = await report_channel.fetch_message(current_report["log_message_id"])
                await log_message.edit(embed=embed)
                return "通報を更新しました。"
            except (discord.NotFound, discord.Forbidden) as e:
                print(f"既存メッセージへのアクセス失敗(新規送信に切替): {e}")
                current_report["log_message_id"] = None
        
        if len(current_report['reporters']) >= report_threshold:
            step = "新規メッセージ送信"
            try:
                sent_message = await report_channel.send(embed=embed, view=ReportView(log_entry["user_id"], message.content, message))
                current_report["log_message_id"] = sent_message.id
                return "規定数の通報があったため、管理者に通知しました。"
            except discord.Forbidden as e:
                channel_name = getattr(report_channel, "name", "不明")
                guild_name = getattr(report_channel.guild, "name", "不明") if hasattr(report_channel, "guild") else "不明"
                return f"エラー: レポートチャンネルへの投稿に失敗しました。\n**送信先**: `{guild_name}` / `#{channel_name}` (ID: `{report_channel.id}`)\n**場所**: `{step}`\n**詳細**: {e}"
        else:
            return f"通報を受け付けました。 (現在 {len(current_report['reporters'])}/{report_threshold} 件)"

    except Exception as e:
        print(f"通報処理エラー [{step}]: {e}")
        return f"通報処理中にエラーが発生しました。\n**失敗した手順**: `{step}`\n**エラー**: {e}"

def is_authorized(obj: discord.Interaction | discord.Message) -> bool:
    user = obj.user if hasattr(obj, 'user') else obj.author
    user_roles = getattr(user, 'roles', [])
    if user.id in ALLOWED_USER_IDS:
        return True
    if any(role.id == ALLOWED_ROLE_ID for role in user_roles):
        return True
    return False
