"""Derived store: the data that cannot be rebuilt from QQ.

`index.sqlite` is disposable — a full rebuild takes about a minute and the page
already says so. Everything expensive lives here instead: OCR text, speech
transcripts, chunked conversations, embeddings. A rebuild of the index must
never invalidate those, because re-running an hour of OCR to satisfy a schema
bump is not a trade a user should be asked to make.

Rows are keyed by `(chat_kind, chat_id, msg_id)` rather than by the index's
rowid: the index reassigns ids on every full rebuild, and the key that survives
is the one QQ assigned.

The file is created by a successful build (`qqnt_query.py`) and is never
deleted by "清理存储"; the storage page lists it separately.
"""
from __future__ import annotations

import os
import sqlite3
import time

#: Bumped when this schema changes. A file written by a newer version is left
#: alone and reported as `stale` instead of being migrated downwards.
DERIVED_VERSION = '1'

BASE_SCHEMA = '''
CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);

-- One message can carry text from several sources; `seq` disambiguates the
-- multiple images or transcripts a single message may contain.
CREATE TABLE content(
    id         INTEGER PRIMARY KEY,
    chat_kind  TEXT    NOT NULL,
    chat_id    TEXT    NOT NULL,
    msg_id     INTEGER NOT NULL,
    source     TEXT    NOT NULL,   -- ocr | asr | file_text | summary | description
    seq        INTEGER NOT NULL DEFAULT 0,
    text       TEXT    NOT NULL,
    engine     TEXT,               -- rapidocr-v4 / paraformer-zh / whisper-small
    model      TEXT,
    conf       REAL,
    lang       TEXT,
    bytes      INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE(chat_kind, chat_id, msg_id, source, seq)
);
CREATE INDEX content_msg ON content(chat_kind, chat_id, msg_id);

-- Retrieval unit for questions: a window of a conversation, not a fixed slice
-- of characters, so an answer keeps the speaker and the order.
CREATE TABLE chunks(
    id         INTEGER PRIMARY KEY,
    chat_kind  TEXT    NOT NULL,
    chat_id    TEXT    NOT NULL,
    start_ts   INTEGER NOT NULL,
    end_ts     INTEGER NOT NULL,
    msg_ids    TEXT    NOT NULL,   -- JSON array of msg_id
    text       TEXT    NOT NULL,
    tokens     INTEGER,
    strategy   TEXT,               -- window | reply-thread | burst
    created_at INTEGER NOT NULL,
    UNIQUE(chat_kind, chat_id, start_ts, strategy)
);

CREATE TABLE vectors(
    chunk_id   INTEGER PRIMARY KEY,
    dim        INTEGER NOT NULL,
    dtype      TEXT    NOT NULL,   -- i8 | f16 | f32
    vec        BLOB    NOT NULL,
    model      TEXT    NOT NULL,
    created_at INTEGER NOT NULL
);
'''

# External-content FTS keeps the transcript and chunk indexes in step with the
# tables through triggers: OCR writes one row, and the keyword index follows
# without every writer having to remember a second insert.
FTS_SCHEMA = '''
CREATE VIRTUAL TABLE content_fts USING fts5(
    text, content='content', content_rowid='id', tokenize='trigram');
CREATE TRIGGER content_ai AFTER INSERT ON content BEGIN
    INSERT INTO content_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER content_ad AFTER DELETE ON content BEGIN
    INSERT INTO content_fts(content_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER content_au AFTER UPDATE ON content BEGIN
    INSERT INTO content_fts(content_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO content_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE VIRTUAL TABLE chunk_fts USING fts5(
    text, content='chunks', content_rowid='id', tokenize='trigram');
CREATE TRIGGER chunk_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunk_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER chunk_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunk_fts(chunk_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER chunk_au AFTER UPDATE ON chunks BEGIN
    INSERT INTO chunk_fts(chunk_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO chunk_fts(rowid, text) VALUES (new.id, new.text);
END;
'''


def connect(path):
    """Open the derived store; callers close it."""
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def _version_of(conn):
    try:
        row = conn.execute("SELECT v FROM meta WHERE k='version'").fetchone()
    except sqlite3.Error:
        return None
    return None if row is None else str(row[0])


def _create(conn):
    conn.executescript(BASE_SCHEMA)
    # A SQLite without FTS5 is supported elsewhere (the index falls back to
    # LIKE), so a missing FTS5 module must not make the store unusable.
    try:
        conn.executescript(FTS_SCHEMA)
        fts = '1'
    except sqlite3.OperationalError:
        fts = '0'
    conn.executemany('INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)', [
        ('version', DERIVED_VERSION),
        ('fts', fts),
        ('createdAt', str(int(time.time()))),
    ])
    conn.commit()
    return fts


def ensure(path):
    """Create the store when missing, or report whether it is current.

    Idempotent and cheap (one file stat plus one row read), so build and query
    entry points can both call it without a flag.

    @param path - `workDir/derived.sqlite`
    @returns dict with `path`, `created`, `version`, `fts`, `stale`
    """
    created = not os.path.exists(path)
    conn = connect(path)
    try:
        if created:
            fts = _create(conn)
            return {'path': path, 'created': True, 'version': DERIVED_VERSION,
                    'fts': fts, 'stale': False}
        version = _version_of(conn)
        if version is None:
            # A stray empty file: treat it as new rather than failing the build.
            fts = _create(conn)
            return {'path': path, 'created': True, 'version': DERIVED_VERSION,
                    'fts': fts, 'stale': False}
        try:
            fts = str(conn.execute("SELECT v FROM meta WHERE k='fts'").fetchone()[0])
        except (sqlite3.Error, TypeError):
            fts = '0'
        return {'path': path, 'created': False, 'version': version,
                'expected': DERIVED_VERSION, 'fts': fts,
                'stale': version != DERIVED_VERSION}
    finally:
        conn.close()


def stats(path):
    """Row counts for the storage page; zeros when the store does not exist."""
    if not os.path.exists(path):
        return {'exists': False, 'content': 0, 'chunks': 0, 'vectors': 0}
    conn = connect(path)
    try:
        def count(table):
            try:
                return conn.execute('SELECT count(*) FROM %s' % table).fetchone()[0]
            except sqlite3.Error:
                return 0
        return {'exists': True, 'content': count('content'),
                'chunks': count('chunks'), 'vectors': count('vectors'),
                'version': _version_of(conn)}
    finally:
        conn.close()
