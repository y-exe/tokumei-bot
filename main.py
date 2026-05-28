import discord
from discord.ext import commands
import os
from dotenv import load_dotenv

from models.constants import *
from utils.json_helper import load_json, save_json
from utils import db
from utils.logging_helper import archive_old_logs
from core.anonymous_logic import update_button_message
from ui.views import AnonymousPostView
from cogs.chat_cog import ChatCog
from cogs.admin_cog import AdminCog
from utils.monitoring import heartbeat_task
from tools.lookup import start_lookup_server

load_dotenv()
db.initialize_database()

intents = discord.Intents.default()
intents.messages = True
intents.message_content = True
intents.guilds = True
bot = commands.Bot(command_prefix='!', intents=intents)

anonymous_channels_data = load_json(CHANNELS_FILE, {})
button_update_locks = {}

@bot.event
async def on_ready():
    print(f'{bot.user} login')
    
    await bot.add_cog(ChatCog(bot, anonymous_channels_data, button_update_locks))
    await bot.add_cog(AdminCog(bot, anonymous_channels_data, button_update_locks))

    try:
        synced = await bot.tree.sync()
        image_cmd = next((cmd for cmd in synced if cmd.name == "image"), None)
        if image_cmd:
            bot.image_command_id = str(image_cmd.id)
            print(f"取得した /image コマンドID: {bot.image_command_id}")
        else:
            bot.image_command_id = "1488490168854908979"
    except Exception as e:
        print(f"コマンドの同期に失敗 : {e}")
        bot.image_command_id = "1488490168854908979"
    from ui.views import AnonymousPostView, ReportView
    for channel_id in anonymous_channels_data:
        mode = anonymous_channels_data[channel_id].get("channel_type", "normal")
        bot.add_view(AnonymousPostView(bot, str(channel_id), anonymous_channels_data, button_update_locks, mode=mode))
    
    bot.add_view(ReportView())
    print("匿名投稿用ボタンおよび処罰ボタンをリスン")
        
    archive_old_logs()
    
    for channel_id in list(anonymous_channels_data.keys()):
        if channel := bot.get_channel(int(channel_id)):
            mode = anonymous_channels_data[channel_id].get("channel_type", "normal")
            await update_button_message(bot, channel, channel_id, anonymous_channels_data, button_update_locks, lambda cid, mode=mode: AnonymousPostView(bot, cid, anonymous_channels_data, button_update_locks, mode=mode))
        else:
            print(f"チャンネル {channel_id} が見つかりませんでした。")
            
    if not heartbeat_task.is_running():
        heartbeat_task.start()
    save_json(CHANNELS_FILE, anonymous_channels_data)

if __name__ == "__main__":
    TOKEN = os.getenv("token")
    if not TOKEN:
        print("ちゃんとToken入れろボケ")
    else:
        print("いずみちゃんToken流出しないでねはーと(起動性交)")
        start_lookup_server()
        bot.run(TOKEN)
