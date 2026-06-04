import json
import os
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

try:
    import psycopg
    from psycopg.rows import dict_row
    from psycopg.types.json import Jsonb
except ImportError:
    psycopg = None
    dict_row = None
    Jsonb = None


_connection = None
_connection_error_shown = False
_disabled = False
_lock = threading.RLock()


def _database_url() -> str | None:
    if url := os.getenv("DATABASE_URL"):
        return url

    host = os.getenv("PGHOST", "localhost")
    port = os.getenv("PGPORT", "5432")
    dbname = os.getenv("PGDATABASE", "postgres")
    user = os.getenv("PGUSER", "postgres")
    password = os.getenv("PGPASSWORD")

    parts = [f"host={host}", f"port={port}", f"dbname={dbname}", f"user={user}"]
    if password:
        parts.append(f"password={password}")
    return " ".join(parts)


def _show_connection_error(exc: Exception):
    global _connection_error_shown, _disabled
    _disabled = True
    if not _connection_error_shown:
        print(f"PostgreSQLに接続できません。JSONファイルにフォールバックします: {exc}")
        _connection_error_shown = True


def get_connection():
    global _connection
    if psycopg is None:
        raise RuntimeError("psycopgがインストールされていません。requirements.txtを更新してインストールしてください。")

    with _lock:
        if _connection is None or _connection.closed:
            _connection = psycopg.connect(_database_url(), row_factory=dict_row, autocommit=True)
        return _connection


def is_enabled() -> bool:
    if _disabled:
        return False

    try:
        get_connection()
        return True
    except Exception as exc:
        _show_connection_error(exc)
        return False


@contextmanager
def cursor():
    with _lock:
        conn = get_connection()
        with conn.cursor() as cur:
            yield cur


def initialize_database():
    if not is_enabled():
        return False

    with cursor() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS app_json_documents (
                name text PRIMARY KEY,
                data jsonb NOT NULL,
                updated_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS anonymous_messages (
                message_id text PRIMARY KEY,
                user_id text NOT NULL,
                user_display_name text,
                anonymous_id integer,
                channel_id text,
                webhook_url text,
                timestamp timestamptz,
                content text NOT NULL DEFAULT '',
                attachment_url text,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
        cur.execute("ALTER TABLE anonymous_messages ADD COLUMN IF NOT EXISTS user_display_name text")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_anonymous_messages_timestamp ON anonymous_messages (timestamp DESC)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_anonymous_messages_user_timestamp ON anonymous_messages (user_id, timestamp DESC)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_anonymous_messages_channel_timestamp ON anonymous_messages (channel_id, timestamp DESC)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_anonymous_messages_anonymous_id ON anonymous_messages (anonymous_id)")
        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_anonymous_messages_content_fts
            ON anonymous_messages USING gin (to_tsvector('simple', content))
            """
        )
    return True


def load_json_document(name: str):
    with cursor() as cur:
        cur.execute("SELECT data FROM app_json_documents WHERE name = %s", (name,))
        row = cur.fetchone()
    if not row:
        return None
    return json.loads(json.dumps(row["data"]))


def save_json_document(name: str, data):
    with cursor() as cur:
        cur.execute(
            """
            INSERT INTO app_json_documents (name, data, updated_at)
            VALUES (%s, %s, now())
            ON CONFLICT (name)
            DO UPDATE SET data = EXCLUDED.data, updated_at = now()
            """,
            (name, Jsonb(data)),
        )


def upsert_message(
    message_id: str,
    user_id: str,
    *,
    user_display_name: str | None = None,
    anonymous_id: int | None = None,
    channel_id: str | None = None,
    webhook_url: str | None = None,
    timestamp: datetime | str | None = None,
    content: str = "",
    attachment_url: str | None = None,
):
    with cursor() as cur:
        cur.execute(
            """
            INSERT INTO anonymous_messages (
                message_id, user_id, user_display_name, anonymous_id, channel_id, webhook_url,
                timestamp, content, attachment_url, updated_at
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, now())
            ON CONFLICT (message_id)
            DO UPDATE SET
                user_id = EXCLUDED.user_id,
                user_display_name = COALESCE(EXCLUDED.user_display_name, anonymous_messages.user_display_name),
                anonymous_id = COALESCE(EXCLUDED.anonymous_id, anonymous_messages.anonymous_id),
                channel_id = COALESCE(EXCLUDED.channel_id, anonymous_messages.channel_id),
                webhook_url = COALESCE(EXCLUDED.webhook_url, anonymous_messages.webhook_url),
                timestamp = COALESCE(EXCLUDED.timestamp, anonymous_messages.timestamp),
                content = EXCLUDED.content,
                attachment_url = COALESCE(EXCLUDED.attachment_url, anonymous_messages.attachment_url),
                updated_at = now()
            """,
            (message_id, user_id, user_display_name, anonymous_id, channel_id, webhook_url, timestamp, content, attachment_url),
        )


def get_message(message_id: str, *, within_days: int | None = None):
    params = [message_id]
    where = "message_id = %s"
    if within_days is not None:
        params.append(datetime.now(timezone.utc) - timedelta(days=within_days))
        where += " AND (timestamp IS NULL OR timestamp >= %s)"

    with cursor() as cur:
        cur.execute(f"SELECT * FROM anonymous_messages WHERE {where}", params)
        return cur.fetchone()


def get_message_log(message_id: str):
    row = get_message(message_id)
    if not row:
        return None
    return {"anonymous_id": row["anonymous_id"], "user_id": row["user_id"]}


def get_latest_message_by_anonymous_id(channel_id: str, anonymous_id: int):
    with cursor() as cur:
        cur.execute(
            """
            SELECT message_id, channel_id, anonymous_id, timestamp
            FROM anonymous_messages
            WHERE channel_id = %s AND anonymous_id = %s
            ORDER BY timestamp DESC NULLS LAST, created_at DESC
            LIMIT 1
            """,
            (channel_id, anonymous_id),
        )
        return cur.fetchone()


def get_recent_log_entry(message_id: str, days: int = 6):
    row = get_message(message_id, within_days=days)
    if not row:
        return None

    data = {
        "user_id": row["user_id"],
        "timestamp": row["timestamp"].isoformat() if row["timestamp"] else None,
        "content": row["content"],
    }
    if row.get("webhook_url"):
        data["webhook_url"] = row["webhook_url"]
    if row.get("attachment_url"):
        data["attachment_url"] = row["attachment_url"]
    return data


def delete_message(message_id: str):
    with cursor() as cur:
        cur.execute("DELETE FROM anonymous_messages WHERE message_id = %s", (message_id,))
