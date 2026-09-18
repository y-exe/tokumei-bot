import discord
import logging
from discord.ext import commands
from discord import app_commands
import asyncio
import os
import re
import shutil
import tempfile
from datetime import datetime, timezone, timedelta
from pathlib import Path
from models.constants import *
from utils.json import load_json, save_json
from utils.logging import get_log_file_path
from utils import db
from core.logic import AnonymousPostRateLimited, AnonymousRequestAccessRevoked, AnonymousUploadTooLarge, build_content_policy_violation_embed, discord_webhook_from_url, get_content_policy_violation, send_anonymous_message, update_button_message, is_authorized
from ui.modals import ReplyModal, EditMessageModal
from ui.views import AnonymousPostView


logger = logging.getLogger(__name__)


def _attachment_extension(attachment: discord.Attachment) -> str:
    return attachment.filename.rsplit(".", 1)[-1].casefold() if "." in attachment.filename else ""


def _can_offer_compression(attachment: discord.Attachment) -> bool:
    size = attachment.size or 0
    return (
        _attachment_extension(attachment) in COMPRESSIBLE_VIDEO_EXTENSIONS
        and MAX_DISCORD_ATTACHMENT_SIZE_BYTES < size <= COMPRESSIBLE_ATTACHMENT_SIZE_BYTES
    )


def _upload_too_large_message(can_compress: bool) -> str:
    message = "Discordに送信できるファイルは20MBまでです。20MB以下のファイルでもう一度やり直してください。"
    if can_compress:
        message += "\nこの動画は自動圧縮できる可能性があります。下のボタンから20MB未満に圧縮して再送信できます。"
    return message


async def _probe_video_duration(ffprobe_path: str, input_path: str) -> float | None:
    process = await asyncio.create_subprocess_exec(
        ffprobe_path,
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        input_path,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await process.communicate()
    if process.returncode != 0:
        return None
    try:
        duration = float(stdout.decode("utf-8", errors="ignore").strip())
    except ValueError:
        return None
    return duration if duration > 0 else None


async def _compress_video_under_limit(attachment: discord.Attachment, directory: str) -> Path:
    ffmpeg_path = shutil.which("ffmpeg")
    if not ffmpeg_path:
        raise RuntimeError("ffmpegが見つからないため、自動圧縮できません。")

    input_path = Path(directory) / Path(attachment.filename).name
    output_path = input_path.with_name(f"{input_path.stem}-compressed.mp4")
    await attachment.save(input_path)

    ffprobe_path = shutil.which("ffprobe")
    duration = await _probe_video_duration(ffprobe_path, str(input_path)) if ffprobe_path else None

    command = [
        ffmpeg_path,
        "-y",
        "-i",
        str(input_path),
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-movflags",
        "+faststart",
    ]
    if duration:
        target_bits = int(MAX_DISCORD_ATTACHMENT_SIZE_BYTES * 8 * 0.92)
        video_bitrate = max(120_000, int(target_bits / duration) - 96_000)
        command.extend(["-b:v", str(video_bitrate), "-maxrate", str(video_bitrate), "-bufsize", str(video_bitrate * 2)])
    else:
        command.extend(["-crf", "32"])
    command.append(str(output_path))

    process = await asyncio.create_subprocess_exec(
        *command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await process.communicate()
    if process.returncode != 0:
        logger.warning(
            "ffmpegによる動画圧縮に失敗しました (filename=%s, stderr=%s)",
            attachment.filename,
            stderr.decode("utf-8", errors="ignore")[-500:],
        )
        raise RuntimeError("動画の圧縮に失敗しました。別のファイルでやり直してください。")
    if output_path.stat().st_size > MAX_DISCORD_ATTACHMENT_SIZE_BYTES:
        raise RuntimeError("圧縮後も20MBを超えたため、自動再送信できませんでした。")
    return output_path


class CompressAndResendView(discord.ui.View):
    def __init__(self, cog: "ChatCog", owner_id: int, attachment: discord.Attachment, content: str):
        super().__init__(timeout=300)
        self.cog = cog
        self.owner_id = owner_id
        self.attachment = attachment
        self.content = content

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if interaction.user.id != self.owner_id:
            await interaction.response.send_message("このボタンは投稿した本人だけが使用できます。", ephemeral=True)
            return False
        return True

    @discord.ui.button(label="20MB未満に圧縮して再送信", style=discord.ButtonStyle.primary)
    async def compress_and_resend(self, interaction: discord.Interaction, button: discord.ui.Button):
        button.disabled = True
        await interaction.response.edit_message(view=self)
        await interaction.followup.send("動画を圧縮しています。少し待ってください。", ephemeral=True)

        try:
            with tempfile.TemporaryDirectory() as directory:
                compressed_path = await _compress_video_under_limit(self.attachment, directory)
                with compressed_path.open("rb") as handle:
                    file = discord.File(handle, filename=compressed_path.name)
                    success = await send_anonymous_message(
                        self.cog.bot,
                        interaction,
                        self.content,
                        self.cog.anonymous_channels_data,
                        attachment_file=file,
                    )
        except AnonymousRequestAccessRevoked:
            return
        except AnonymousPostRateLimited as exc:
            await interaction.followup.send(
                f"連続投稿はできません。あと約 {exc.retry_after_seconds} 秒待ってください。",
                ephemeral=True,
            )
            return
        except AnonymousUploadTooLarge:
            await interaction.followup.send("圧縮後も20MBを超えたため、Discordに送信できませんでした。", ephemeral=True)
            return
        except Exception as exc:
            logger.exception("添付ファイルの自動圧縮に失敗しました (filename=%s)", self.attachment.filename)
            await interaction.followup.send(str(exc) or "自動圧縮に失敗しました。", ephemeral=True)
            return

        if success:
            channel_data = self.cog.anonymous_channels_data.get(str(interaction.channel.id), {})
            mode = channel_data.get("channel_type", "normal")
            view_factory = lambda cid, mode=mode: AnonymousPostView(self.cog.bot, cid, self.cog.anonymous_channels_data, self.cog.button_update_locks, mode=mode)
            await update_button_message(self.cog.bot, interaction.channel, str(interaction.channel.id), self.cog.anonymous_channels_data, self.cog.button_update_locks, view_factory)
            await interaction.followup.send("圧縮して投稿しました。", ephemeral=True)
        else:
            await interaction.followup.send("圧縮後の投稿に失敗しました。", ephemeral=True)


class ChatCog(commands.Cog):
    def __init__(self, bot, anonymous_channels_data, button_update_locks):
        self.bot = bot
        self.anonymous_channels_data = anonymous_channels_data
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

        log_entry = db.get_message_log(str(message.id)) if db.is_enabled() else load_json(MESSAGE_LOGS_FILE, {}).get(str(message.id))
        if not log_entry or "anonymous_id" not in log_entry:
            await interaction.response.send_message("返信先のメッセージ情報が見つかりませんでした。", ephemeral=True)
            return
        
        modal = ReplyModal(
            self.bot, message, str(log_entry["anonymous_id"]),
            self.anonymous_channels_data, self.button_update_locks
        )
        await interaction.response.send_modal(modal)

    async def edit_message(self, interaction: discord.Interaction, message: discord.Message):
        log_entry = db.get_message_log(str(message.id)) if db.is_enabled() else load_json(MESSAGE_LOGS_FILE, {}).get(str(message.id))
        
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
        message_logs = None if db.is_enabled() else load_json(MESSAGE_LOGS_FILE, {})
        log_entry = db.get_message_log(str(message.id)) if db.is_enabled() else message_logs.get(str(message.id))

        if not log_entry or str(interaction.user.id) != log_entry.get("user_id"):
            await interaction.response.send_message("これはあなたが削除できるメッセージではありません。", ephemeral=True)
            return
        
        channel_data = self.anonymous_channels_data.get(str(interaction.channel_id), {})
        if not (webhook_url := channel_data.get("webhook_url")):
            await interaction.response.send_message("このチャンネルのWebhook設定が見つかりません。", ephemeral=True)
            return
            
        try:
            webhook = discord_webhook_from_url(webhook_url, self.bot)
            await webhook.delete_message(message.id)
            await interaction.response.send_message("メッセージを削除しました。", ephemeral=True)
            
            if db.is_enabled():
                db.delete_message(str(message.id))
            else:
                for i in range(6):
                    log_file = get_log_file_path(datetime.now(timezone.utc) - timedelta(days=i))
                    if os.path.exists(log_file) and str(message.id) in (log_data := load_json(log_file, {})):
                        del log_data[str(message.id)]
                        save_json(log_file, log_data)
                        break
                
                del message_logs[str(message.id)]
                save_json(MESSAGE_LOGS_FILE, message_logs)
                
        except Exception:
            logger.exception("匿名メッセージの削除に失敗しました (message_id=%s)", message.id)
            await interaction.response.send_message("削除中にエラーが発生しました。", ephemeral=True)

    @app_commands.command(name="image", description="匿名チャンネルにファイルを投稿します。")
    @app_commands.describe(attachment="投稿するファイル", content="添えるメッセージ（任意）")
    async def post_image(self, interaction: discord.Interaction, attachment: discord.Attachment, content: str = ""):
        if str(interaction.channel.id) not in self.anonymous_channels_data:
            await interaction.response.send_message("このチャンネルは匿名チャンネルではありません。", ephemeral=True)
            return

        from core.logic import send_anonymous_message

        if violation := get_content_policy_violation(content):
            await interaction.response.send_message(embed=build_content_policy_violation_embed(content), ephemeral=True)
            return

        can_compress = _can_offer_compression(attachment)
        if (attachment.size or 0) > MAX_DISCORD_ATTACHMENT_SIZE_BYTES:
            view = CompressAndResendView(self, interaction.user.id, attachment, content) if can_compress else None
            await interaction.response.send_message(_upload_too_large_message(can_compress), view=view, ephemeral=True)
            return

        await interaction.response.defer(ephemeral=True)
        try:
            success = await send_anonymous_message(self.bot, interaction, content, self.anonymous_channels_data, attachment=attachment)
        except AnonymousRequestAccessRevoked:
            return
        except AnonymousPostRateLimited as exc:
            await interaction.followup.send(
                f"連続投稿はできません。あと約 {exc.retry_after_seconds} 秒待ってください。",
                ephemeral=True,
            )
            return
        except AnonymousUploadTooLarge:
            can_compress = _can_offer_compression(attachment)
            view = CompressAndResendView(self, interaction.user.id, attachment, content) if can_compress else None
            await interaction.followup.send(_upload_too_large_message(can_compress), view=view, ephemeral=True)
            return
        if success:
            from ui.views import AnonymousPostView
            channel_data = self.anonymous_channels_data.get(str(interaction.channel.id), {})
            mode = channel_data.get("channel_type", "normal")
            view_factory = lambda cid, mode=mode: AnonymousPostView(self.bot, cid, self.anonymous_channels_data, self.button_update_locks, mode=mode)
            await update_button_message(self.bot, interaction.channel, str(interaction.channel.id), self.anonymous_channels_data, self.button_update_locks, view_factory)
            await interaction.followup.send("ファイルを投稿しました。", ephemeral=True)
        else:
            await interaction.followup.send("ファイルの投稿に失敗しました。", ephemeral=True)

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        if message.author.bot: return
        channel_id = str(message.channel.id)
        if channel_id in self.anonymous_channels_data:
            channel_data = self.anonymous_channels_data[channel_id]
            if channel_data.get("channel_type") == "request":
                from core.logic import update_button_message
                from ui.views import AnonymousPostView
                mode = "request"
                view_factory = lambda cid, mode=mode: AnonymousPostView(self.bot, cid, self.anonymous_channels_data, self.button_update_locks, mode=mode)
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
                except Exception:
                    logger.exception("通常投稿の自動削除に失敗しました (channel_id=%s)", channel_id)

async def setup(bot, anonymous_channels_data, button_update_locks):
    await bot.add_cog(ChatCog(bot, anonymous_channels_data, button_update_locks))
