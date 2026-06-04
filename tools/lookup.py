import html
import json
import os
import re
import sys
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
load_dotenv(ROOT / ".env")

from utils import db  # noqa: E402
from utils.json import load_json  # noqa: E402
from models.constants import GUILD_SETTINGS_FILE  # noqa: E402


user_cache = {}
lookup_server = None
lookup_thread = None

# http://127.0.0.1:8765/ にサイトができるよ！！そっから特定

def api_json(path):
    token = os.getenv("token")
    if not token:
        return None

    request = urllib.request.Request(
        f"https://discord.com/api/v10{path}",
        headers={
            "Authorization": f"Bot {token}",
            "User-Agent": "DiscordBot (tokumei lookup, 1.0)",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            return json.loads(response.read().decode("utf-8"))
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return None


def guild_ids():
    settings = load_json(GUILD_SETTINGS_FILE, {})
    return list(settings.keys())


def discord_name(user_id):
    if user_id in user_cache:
        return user_cache[user_id]

    for guild_id in guild_ids():
        member = api_json(f"/guilds/{guild_id}/members/{user_id}")
        if member:
            user = member.get("user", {})
            name = member.get("nick") or user.get("global_name") or user.get("username")
            if name:
                user_cache[user_id] = name
                return name

    user = api_json(f"/users/{user_id}")
    if user:
        name = user.get("global_name") or user.get("username")
        if name:
            user_cache[user_id] = name
            return name

    return None


def lookup(message_id):
    if not re.fullmatch(r"\d{17,20}", message_id):
        return None, "メッセージIDは17〜20桁の数字で入力してください。"

    if not db.initialize_database():
        return None, "PostgreSQLに接続できません。"

    row = db.get_message(message_id)
    if not row:
        return None, "見つかりませんでした。"

    name = row.get("user_display_name") or discord_name(row["user_id"]) or "取得不可"
    return {"user_id": row["user_id"], "name": name}, None


def page(message_id="", result=None, error=None):
    message_id = html.escape(message_id)
    body = [
        "<!doctype html>",
        '<html lang="ja">',
        "<head>",
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        "<title>匿名lookup!!!</title>",
        "</head>",
        "<body>",
        "<h1>匿名lookup!!!</h1>",
        '<form method="get">',
        f'<input name="id" value="{message_id}" placeholder="メッセージID">',
        '<button type="submit">検索</button>',
        "</form>",
    ]

    if error:
        body.append(f"<p>{html.escape(error)}</p>")
    if result:
        body.extend(
            [
                "<hr>",
                "<dl>",
                "<dt>ユーザーID</dt>",
                f"<dd>{html.escape(result['user_id'])}</dd>",
                "<dt>表示名</dt>",
                f"<dd>{html.escape(result['name'])}</dd>",
                "</dl>",
            ]
        )

    body.extend(["</body>", "</html>"])
    return "\n".join(body).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        query = parse_qs(urlparse(self.path).query)
        message_id = query.get("id", [""])[0].strip()
        result = None
        error = None

        if message_id:
            result, error = lookup(message_id)

        body = page(message_id, result, error)
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    host = os.getenv("LOOKUP_HOST", "127.0.0.1")
    port = int(os.getenv("LOOKUP_PORT", "8765"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"lookup: http://{host}:{port}/")
    server.serve_forever()


def start_lookup_server():
    global lookup_server, lookup_thread

    if lookup_thread and lookup_thread.is_alive():
        return True

    host = os.getenv("LOOKUP_HOST", "127.0.0.1")
    port = int(os.getenv("LOOKUP_PORT", "8765"))

    try:
        lookup_server = ThreadingHTTPServer((host, port), Handler)
    except OSError as exc:
        print(f"lookupの起動に失敗: http://{host}:{port}/ ({exc})")
        return False

    lookup_thread = threading.Thread(
        target=lookup_server.serve_forever,
        name="lookup-server",
        daemon=True,
    )
    lookup_thread.start()
    return True


if __name__ == "__main__":
    main()
