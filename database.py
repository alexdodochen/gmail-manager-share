"""SQLite 狀態：記錄處理過的信、待辦/截止、跟催，避免重複處理與重複草稿。"""
import sqlite3
import json
from contextlib import contextmanager
import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
    msg_id        TEXT PRIMARY KEY,
    thread_id     TEXT,
    sender        TEXT,
    sender_email  TEXT,
    subject       TEXT,
    date_utc      TEXT,
    category      TEXT,
    importance    INTEGER,      -- 1(低)~5(高)
    is_real_person INTEGER,
    needs_reply   INTEGER,
    is_urgent     INTEGER,
    language      TEXT,
    tldr          TEXT,
    todos         TEXT,         -- JSON array of {task, due}
    draft_id      TEXT,
    alerted       INTEGER DEFAULT 0,
    classified_by TEXT,         -- 'rule' / 'gemini'
    processed_at  TEXT
);
CREATE TABLE IF NOT EXISTS state (
    key   TEXT PRIMARY KEY,
    value TEXT
);
CREATE TABLE IF NOT EXISTS followups (
    thread_id  TEXT PRIMARY KEY,
    subject    TEXT,
    recipient  TEXT,
    sent_date  TEXT,
    reminded   INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_msg_date ON messages(date_utc);
CREATE INDEX IF NOT EXISTS idx_msg_cat  ON messages(category);
"""


@contextmanager
def connect():
    conn = sqlite3.connect(config.DB_FILE)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with connect() as conn:
        conn.executescript(SCHEMA)


def is_processed(msg_id):
    with connect() as conn:
        row = conn.execute("SELECT 1 FROM messages WHERE msg_id=?", (msg_id,)).fetchone()
        return row is not None


def save_message(rec):
    rec = dict(rec)
    rec["todos"] = json.dumps(rec.get("todos", []), ensure_ascii=False)
    cols = ("msg_id thread_id sender sender_email subject date_utc category importance "
            "is_real_person needs_reply is_urgent language tldr todos draft_id alerted "
            "classified_by processed_at").split()
    placeholders = ",".join("?" for _ in cols)
    with connect() as conn:
        conn.execute(
            f"INSERT OR REPLACE INTO messages ({','.join(cols)}) VALUES ({placeholders})",
            tuple(rec.get(c) for c in cols),
        )


def mark_alerted(msg_id):
    with connect() as conn:
        conn.execute("UPDATE messages SET alerted=1 WHERE msg_id=?", (msg_id,))


def get_messages_between(start_iso, end_iso):
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM messages WHERE date_utc>=? AND date_utc<? ORDER BY date_utc DESC",
            (start_iso, end_iso),
        ).fetchall()
        return [dict(r) for r in rows]


def get_unalerted_urgent():
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM messages WHERE is_urgent=1 AND alerted=0"
        ).fetchall()
        return [dict(r) for r in rows]


def get_state(key, default=None):
    with connect() as conn:
        row = conn.execute("SELECT value FROM state WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default


def set_state(key, value):
    with connect() as conn:
        conn.execute("INSERT OR REPLACE INTO state(key,value) VALUES(?,?)", (key, str(value)))


# ── 跟催 ────────────────────────────────────────────────
def upsert_followup(thread_id, subject, recipient, sent_date):
    with connect() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO followups(thread_id,subject,recipient,sent_date) VALUES(?,?,?,?)",
            (thread_id, subject, recipient, sent_date),
        )


def clear_followup(thread_id):
    with connect() as conn:
        conn.execute("DELETE FROM followups WHERE thread_id=?", (thread_id,))


def get_pending_followups():
    with connect() as conn:
        rows = conn.execute("SELECT * FROM followups WHERE reminded=0").fetchall()
        return [dict(r) for r in rows]


def mark_followup_reminded(thread_id):
    with connect() as conn:
        conn.execute("UPDATE followups SET reminded=1 WHERE thread_id=?", (thread_id,))
