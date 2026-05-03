CHANNELS_FILE = 'channels.json'
USER_DATA_FILE = 'user_data.json'
THRESHOLDS_FILE = 'thresholds.json'
DOMAINS_FILE = 'domains.json'
KEYWORDS_FILE = 'keywords.json'
BANNED_USERS_FILE = 'banned_users.json'
GUILD_SETTINGS_FILE = 'guild_settings.json'
ANONYMOUS_DATA_FILE = 'anonymous_data.json'
MESSAGE_LOGS_FILE = 'message_logs.json'

ALLOWED_ROLE_ID = 1368911481063866449 # 赤鯖運営ロール
ALLOWED_USER_IDS = [703734573108035715, 1102557945889300480, 962536883219472414, 1438769007636385914, 1457705424022274235] #y_exe本人等
CONTINUOUS_POST_THRESHOLD_MINUTES = 20

DEFAULT_THRESHOLDS = {"report": 3} # 赤鯖は1らしい。とりあえずデフォは3 コマンドでいじってください
DEFAULT_DOMAINS = ["pornhub.com", "xvideos.com", "dlsite.com"]
# う...う..!!!! うおwww ← ????????
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
    "RMT", "垢販売", "アカウント売買", "儲かるS", "稼げる", "副業"
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
