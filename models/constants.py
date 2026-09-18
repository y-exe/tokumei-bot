DATA_DIR = 'detas'

CHANNELS_FILE = f'{DATA_DIR}/channels.json'
USER_DATA_FILE = f'{DATA_DIR}/user_data.json'
THRESHOLDS_FILE = f'{DATA_DIR}/thresholds.json'
DOMAINS_FILE = f'{DATA_DIR}/domains.json'
KEYWORDS_FILE = f'{DATA_DIR}/keywords.json'
GUILD_SETTINGS_FILE = f'{DATA_DIR}/guild_settings.json'
ANONYMOUS_DATA_FILE = f'{DATA_DIR}/anonymous_data.json'
MESSAGE_LOGS_FILE = f'{DATA_DIR}/message_logs.json'
PUNISHMENT_HISTORY_FILE = f'{DATA_DIR}/punishment_history.json'
REPORTS_FILE = f'{DATA_DIR}/reports.json'
BANNED_USERS_FILE = f'{DATA_DIR}/banned_users.json'

ALLOWED_ROLE_ID = 1368911481063866449 # 赤鯖運営ロール
ALLOWED_USER_IDS = [483307286513582090, 1275438024250888237, 1459535429823893538] #y_exe本人等
CONTINUOUS_POST_THRESHOLD_MINUTES = 20
ANONYMOUS_POST_COOLDOWN_SECONDS = 5
MAX_DISCORD_ATTACHMENT_SIZE_BYTES = 20 * 1024 * 1024
COMPRESSIBLE_ATTACHMENT_SIZE_BYTES = 120 * 1024 * 1024

DEFAULT_THRESHOLDS = {"report": 3} # 赤鯖は1らしい。とりあえずデフォは3 コマンドでいじってください
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
AVATAR_URLS = [ # discordデフォアイコンのURL
    "https://cdn.discordapp.com/embed/avatars/0.png",
    "https://cdn.discordapp.com/embed/avatars/1.png",
    "https://cdn.discordapp.com/embed/avatars/2.png",
    "https://cdn.discordapp.com/embed/avatars/3.png",
    "https://cdn.discordapp.com/embed/avatars/4.png",
    "https://cdn.discordapp.com/embed/avatars/5.png"
]
VIDEO_EXTENSIONS = ['mp4', 'mov', 'webm', 'avi', 'mkv', 'flv', 'gif']
COMPRESSIBLE_VIDEO_EXTENSIONS = ['mp4', 'mov', 'webm', 'avi', 'mkv', 'flv', 'gif']
