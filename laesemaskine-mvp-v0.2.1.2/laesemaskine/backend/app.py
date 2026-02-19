"""Læsemaskine backend (Flask + SQLite)
Version: 0.2.1.2.2
"""

from __future__ import annotations
import json
import os
import sqlite3
import uuid
import re
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from flask import Flask, jsonify, request, session, send_from_directory
from werkzeug.security import generate_password_hash, check_password_hash

BASE_DIR = Path(__file__).resolve().parent
DB_DIR = BASE_DIR / "db"
DB_PATH = DB_DIR / "laesemaskine.db"
SCHEMA_PATH = DB_DIR / "schema.sql"

UPLOAD_DIR = (BASE_DIR / "uploads").resolve()
WORDS_JSON_PATH = (BASE_DIR.parent / "data" / "words.json").resolve()

def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn

def init_db() -> None:
    DB_DIR.mkdir(parents=True, exist_ok=True)
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    conn = get_db()
    try:
        with open(SCHEMA_PATH, "r", encoding="utf-8") as f:
            conn.executescript(f.read())
        migrate_db(conn)
        conn.commit()
    finally:
        conn.close()


def _norm_word(s: Optional[str]) -> str:
    if not s:
        return ""
    s = s.strip().lower()
    # keep danish letters; remove surrounding punctuation
    s = re.sub(r"^[^a-zæøå]+|[^a-zæøå]+$", "", s)
    return s

ENDING_LIST = ["ende","ene","ede","er","et","en","e","r"]  # order matters (longest first)
VOWELS = set(list("aeiouyæøå"))

def diagnose_v1(expected: str, recognized: Optional[str]) -> Dict[str, Any]:
    exp = _norm_word(expected)
    rec = _norm_word(recognized)
    if not exp or not rec:
        return {"correct": False, "error_type": None, "message_short": "", "message_detail": ""}

    if exp == rec:
        return {"correct": True, "error_type": None, "message_short": "Korrekt", "message_detail": "Udtalen ser korrekt ud."}

    # missing ending
    for end in ENDING_LIST:
        if exp.endswith(end) and rec == exp[: -len(end)]:
            return {
                "correct": False,
                "error_type": "missing_ending",
                "message_short": "Mangler endelse",
                "message_detail": f"Du mangler endelsen -{end}.",
            }
        if exp.endswith(end) and rec == exp[:-len(end)] + end[:-1] and len(end) > 1:
            # near missing last char of ending, still treat as missing ending
            return {
                "correct": False,
                "error_type": "missing_ending",
                "message_short": "Mangler endelse",
                "message_detail": f"Endelsen -{end} er ikke helt tydelig.",
            }

    # extra ending
    for end in ENDING_LIST:
        if rec.endswith(end) and exp == rec[: -len(end)]:
            return {
                "correct": False,
                "error_type": "extra_ending",
                "message_short": "Ekstra endelse",
                "message_detail": f"Der kom en ekstra endelse -{end}.",
            }

    # near match (Levenshtein distance <= 1)
    def _lev1(a: str, b: str) -> int:
        # small optimized distance with early exit >1
        if a == b:
            return 0
        if abs(len(a) - len(b)) > 1:
            return 2
        # substitution / insertion / deletion
        i = j = 0
        edits = 0
        while i < len(a) and j < len(b):
            if a[i] == b[j]:
                i += 1; j += 1
            else:
                edits += 1
                if edits > 1:
                    return edits
                if len(a) > len(b):
                    i += 1
                elif len(b) > len(a):
                    j += 1
                else:
                    i += 1; j += 1
        if i < len(a) or j < len(b):
            edits += 1
        return edits

    if _lev1(exp, rec) <= 1:
        return {
            "correct": False,
            "error_type": "near_match",
            "message_short": "Næsten",
            "message_detail": "Det var næsten rigtigt — et lille lyd/bogstav skiller.",
        }

    # vowel swap heuristic: same consonants pattern
    def cons_pattern(s: str) -> str:
        return "".join([ch for ch in s if ch not in VOWELS])

    if len(exp) == len(rec) and cons_pattern(exp) == cons_pattern(rec):
        return {
            "correct": False,
            "error_type": "vowel_swap",
            "message_short": "Vokal",
            "message_detail": "Vokalen lyder anderledes end forventet.",
        }

    # cluster issue: drop one consonant in initial cluster
    clusters = ["str","skr","spr","spl","skl","sk","sp","st","tr","dr","br","bl","kl","kr","gr","gl","pl","pr"]
    for cl in clusters:
        if exp.startswith(cl) and rec.startswith(cl[1:]):
            return {
                "correct": False,
                "error_type": "cluster_issue",
                "message_short": "Konsonantklynge",
                "message_detail": f"Konsonantklyngen '{cl}-' kan være svær her.",
            }

    return {"correct": False, "error_type": "other", "message_short": "Forkert", "message_detail": "Udtalen matcher ikke ordet helt."}



def migrate_db(conn: sqlite3.Connection) -> None:
    """Best-effort schema migrations for existing DBs."""
    # lm_session_words: add start_ms/end_ms + error_type
    for stmt in [
        "ALTER TABLE lm_session_words ADD COLUMN start_ms INTEGER NULL;",
        "ALTER TABLE lm_session_words ADD COLUMN end_ms INTEGER NULL;",
        "ALTER TABLE lm_session_words ADD COLUMN error_type TEXT NULL;",
        "ALTER TABLE lm_sessions ADD COLUMN session_audio_path TEXT NULL;",
        "ALTER TABLE lm_sessions ADD COLUMN session_audio_mime TEXT NULL;",
        "ALTER TABLE lm_sessions ADD COLUMN session_audio_uploaded_at TEXT NULL;",
    ]:
        try:
            conn.execute(stmt)
        except sqlite3.OperationalError:
            pass


def load_words() -> Dict[str, Any]:
    with open(WORDS_JSON_PATH, "r", encoding="utf-8") as f:
        return json.load(f)

WORDS_CACHE = None

def words_cache() -> Dict[str, Any]:
    global WORDS_CACHE
    if WORDS_CACHE is None:
        WORDS_CACHE = load_words()
    return WORDS_CACHE

def word_meta_by_id(word_id: int) -> Optional[Dict[str, Any]]:
    payload = words_cache()
    words = payload.get("words", [])
    # word_id is 1-based in words.json
    if 1 <= word_id <= len(words):
        return words[word_id - 1]
    # fallback linear (should not happen)
    for w in words:
        if w.get("id") == word_id:
            return w
    return None


def current_user(conn: sqlite3.Connection) -> Optional[sqlite3.Row]:
    uid = session.get("user_id")
    if not uid:
        return None
    cur = conn.execute("SELECT * FROM lm_users WHERE id=?", (uid,))
    return cur.fetchone()

def require_login(conn: sqlite3.Connection) -> Tuple[Optional[sqlite3.Row], Optional[Any]]:
    user = current_user(conn)
    if not user:
        return None, (jsonify({"error":"not_logged_in"}), 401)
    return user, None

def require_admin(conn: sqlite3.Connection) -> Tuple[Optional[sqlite3.Row], Optional[Any]]:
    user, resp = require_login(conn)
    if resp:
        return None, resp
    if user["role"] != "admin":
        return None, (jsonify({"error":"forbidden"}), 403)
    return user, None

def normalize_text(s: str) -> str:
    s = (s or "").strip().lower()
    # Keep danish letters, remove punctuation/spaces
    out = []
    for ch in s:
        if ch.isalnum() or ch in "æøå":
            out.append(ch)
    return "".join(out)

app = Flask(__name__, static_folder=str((BASE_DIR.parent / "frontend").resolve()), static_url_path="/laesemaskine")

@app.get('/favicon.ico')
def favicon():
    return ('', 204)

app.secret_key = os.environ.get("LM_SECRET_KEY", "dev-secret-change-me")

@app.route("/laesemaskine/api/health")
def health():
    return jsonify({"ok": True, "version": "0.1.0"})

@app.route("/laesemaskine/api/auth/register", methods=["POST"])
def register():
    data = request.get_json(force=True, silent=True) or {}
    username = (data.get("username") or "").strip()
    password = (data.get("password") or "").strip()
    role = (data.get("role") or "elev").strip()
    display_name = (data.get("display_name") or "").strip() or None
    join_group_code = (data.get("join_group_code") or "").strip() or None  # reserved for later

    if not username or not password:
        return jsonify({"error":"missing_username_or_password"}), 400
    if role not in ("elev","admin"):
        return jsonify({"error":"invalid_role"}), 400

    conn = get_db()
    try:
        pw_hash = generate_password_hash(password)
        try:
            conn.execute(
                "INSERT INTO lm_users (username, password_hash, role, display_name) VALUES (?,?,?,?)",
                (username, pw_hash, role, display_name),
            )
            conn.commit()
        except sqlite3.IntegrityError:
            return jsonify({"error":"username_taken"}), 409

        uid = conn.execute("SELECT id FROM lm_users WHERE username=?", (username,)).fetchone()["id"]
        session["user_id"] = uid
        return jsonify({"ok": True, "user": {"id": uid, "username": username, "role": role, "display_name": display_name}})
    finally:
        conn.close()

@app.route("/laesemaskine/api/auth/login", methods=["POST"])
def login():
    data = request.get_json(force=True, silent=True) or {}
    username = (data.get("username") or "").strip()
    password = (data.get("password") or "").strip()
    if not username or not password:
        return jsonify({"error":"missing_username_or_password"}), 400

    conn = get_db()
    try:
        user = conn.execute("SELECT * FROM lm_users WHERE username=?", (username,)).fetchone()
        if not user or not check_password_hash(user["password_hash"], password):
            return jsonify({"error":"invalid_credentials"}), 401
        session["user_id"] = user["id"]
        return jsonify({"ok": True, "user": {"id": user["id"], "username": user["username"], "role": user["role"], "display_name": user["display_name"], "group_id": user["group_id"]}})
    finally:
        conn.close()

@app.route("/laesemaskine/api/auth/logout", methods=["POST"])
def logout():
    session.pop("user_id", None)
    return jsonify({"ok": True})

@app.route("/laesemaskine/api/me")
def me():
    conn = get_db()
    try:
        user, resp = require_login(conn)
        if resp:
            return resp
        # current mastery snapshot
        mastery = conn.execute(
            "SELECT level, mastery_1_10, updated_at FROM lm_mastery WHERE user_id=? ORDER BY level",
            (user["id"],),
        ).fetchall()
        return jsonify({
            "ok": True,
            "user": {
                "id": user["id"],
                "username": user["username"],
                "role": user["role"],
                "display_name": user["display_name"],
                "group_id": user["group_id"],
            },
            "mastery": [dict(r) for r in mastery],
        })
    finally:
        conn.close()

@app.route("/laesemaskine/api/words")
def get_words():
    """Return N words filtered by target level and optional bands."""
    conn = get_db()
    try:
        user, resp = require_login(conn)
        if resp:
            return resp

        payload = words_cache()
        words = payload.get("words", [])

        try:
            target_level = int(request.args.get("level", "1"))
        except ValueError:
            target_level = 1
        count = int(request.args.get("count", "20"))
        band = int(request.args.get("band", "0"))  # 0 = exact, 1 = +/-1, 2 = +/-2 etc.

        def in_band(w):
            lvl = w.get("niveau")
            if lvl is None:
                return False
            if band <= 0:
                return lvl == target_level
            return abs(lvl - target_level) <= band

        pool = [w for w in words if in_band(w)]
        if len(pool) < count:
            # fallback: any words with level
            pool = [w for w in words if w.get("niveau") is not None]

        import random
        random.shuffle(pool)
        selected = pool[:count]
        # trim raw to keep payload small
        slim = []
        for w in selected:
            slim.append({
                "id": w["id"],
                "ord": w["ord"],
                "niveau": w.get("niveau"),
                "fase": w.get("fase"),
                "stavemoenster": w.get("stavemoenster"),
                "ordblind_risiko": w.get("ordblind_risiko"),
                "interessekategori": w.get("interessekategori"),
            })
        return jsonify({"ok": True, "level": target_level, "count": len(slim), "words": slim})
    finally:
        conn.close()

@app.route("/laesemaskine/api/sessions/start", methods=["POST"])
def session_start():
    conn = get_db()
    try:
        user, resp = require_login(conn)
        if resp:
            return resp
        data = request.get_json(force=True, silent=True) or {}
        feedback_mode = (data.get("feedback_mode") or "per_word").strip()
        if feedback_mode not in ("per_word","after_test"):
            feedback_mode = "per_word"

        cur = conn.execute(
            "INSERT INTO lm_sessions (user_id, feedback_mode) VALUES (?,?)",
            (user["id"], feedback_mode),
        )
        conn.commit()
        sid = cur.lastrowid
        return jsonify({"ok": True, "session_id": sid})
    finally:
        conn.close()

@app.route("/laesemaskine/api/sessions/<int:sid>/answer", methods=["POST"])
def session_answer(sid: int):
    conn = get_db()
    try:
        user, resp = require_login(conn)
        if resp:
            return resp

        # ownership check
        sess = conn.execute("SELECT * FROM lm_sessions WHERE id=? AND user_id=?", (sid, user["id"])).fetchone()
        if not sess:
            return jsonify({"error":"session_not_found"}), 404

        data = request.get_json(force=True, silent=True) or {}
        word_id = int(data.get("word_id"))
        expected = (data.get("expected") or "").strip()
        recognized = (data.get("recognized") or "").strip()
        response_time_ms = data.get("response_time_ms")
        start_ms = data.get("start_ms")
        end_ms = data.get("end_ms")
        visible_ms = data.get("visible_ms")
        level = data.get("level")
        try:
            response_time_ms = int(response_time_ms) if response_time_ms is not None else None
        except ValueError:
            response_time_ms = None
        try:
            start_ms = int(start_ms) if start_ms is not None else None
        except ValueError:
            start_ms = None
        try:
            end_ms = int(end_ms) if end_ms is not None else None
        except ValueError:
            end_ms = None
        try:
            visible_ms = int(visible_ms) if visible_ms is not None else None
        except ValueError:
            visible_ms = None
        try:
            level = int(level) if level is not None else None
        except ValueError:
            level = None

        expected_n = normalize_text(expected)
        recognized_n = normalize_text(recognized)
        correct = 1 if (expected_n and expected_n == recognized_n) else 0

        cur = conn.execute(
            "INSERT INTO lm_session_words (session_id, word_id, expected, recognized, correct, response_time_ms, start_ms, end_ms, visible_ms, error_type) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (sid, word_id, expected, recognized, correct, response_time_ms, start_ms, end_ms, visible_ms, diagnose_v1(expected, recognized).get('error_type')),
        )
        session_word_id = cur.lastrowid
# Update totals
        conn.execute(
            "UPDATE lm_sessions SET total_words = total_words + 1, correct_total = correct_total + ? WHERE id=?",
            (correct, sid),
        )
        conn.commit()
        return jsonify({"ok": True, "session_word_id": session_word_id, "correct": bool(correct), "diagnostics": diagnose_v1(expected, recognized), "error_type": diagnose_v1(expected, recognized).get("error_type"), "normalized": {"expected": expected_n, "recognized": recognized_n}})
    finally:
        conn.close()

@app.route("/laesemaskine/api/sessions/<int:sid>/finish", methods=["POST"])
def session_finish(sid: int):
    conn = get_db()
    try:
        user, resp = require_login(conn)
        if resp:
            return resp

        sess = conn.execute("SELECT * FROM lm_sessions WHERE id=? AND user_id=?", (sid, user["id"])).fetchone()
        if not sess:
            return jsonify({"error":"session_not_found"}), 404

        data = request.get_json(force=True, silent=True) or {}
        estimated_level = data.get("estimated_level")
        try:
            estimated_level = int(estimated_level) if estimated_level is not None else None
        except ValueError:
            estimated_level = None

        conn.execute(
            "UPDATE lm_sessions SET ended_at=datetime('now'), estimated_level=? WHERE id=?",
            (estimated_level, sid),
        )

        # Update mastery for the estimated level: simple MVP formula
        total = int(sess["total_words"])
        correct = int(sess["correct_total"])
        # If finish called before any answers, recompute live
        if total == 0:
            totals = conn.execute(
                "SELECT COUNT(*) AS total, SUM(correct) AS correct FROM lm_session_words WHERE session_id=?",
                (sid,),
            ).fetchone()
            total = int(totals["total"] or 0)
            correct = int(totals["correct"] or 0)
        mastery = None
        if estimated_level is not None and total > 0:
            mastery = max(1, min(10, int(round((correct / total) * 10))))
            conn.execute(
                "INSERT INTO lm_mastery (user_id, level, mastery_1_10) VALUES (?,?,?) "
                "ON CONFLICT(user_id, level) DO UPDATE SET mastery_1_10=excluded.mastery_1_10, updated_at=datetime('now')",
                (user["id"], estimated_level, mastery),
            )


        # --- v0.2.1.2.2: per-level mastery + speed-aware score ---
        try:
            rows = conn.execute(
                "SELECT word_id, correct, response_time_ms, visible_ms FROM lm_session_words WHERE session_id=?",
                (sid,),
            ).fetchall()
            per_level = {}
            for r in rows:
                wm = word_meta_by_id(int(r["word_id"])) or {}
                lvl = int(wm.get("niveau") or (estimated_level or 1))
                st = per_level.get(lvl) or {"total":0,"correct":0,"speedSum":0.0,"speedCount":0}
                st["total"] += 1
                if int(r["correct"] or 0)==1:
                    st["correct"] += 1
                    vms = r["visible_ms"]
                    rt = r["response_time_ms"]
                    if vms and rt is not None:
                        try:
                            vms = float(vms); rt=float(rt)
                            speedNorm = max(0.0, min(1.0, 1.0 - (rt / vms)))
                            st["speedSum"] += speedNorm
                            st["speedCount"] += 1
                        except Exception:
                            pass
                per_level[lvl]=st

            # compute session metrics
            acc_all = (correct / total) if total else 0.0
            speed_all_list = []
            for lvl, st in per_level.items():
                if st["speedCount"]>0:
                    speed_all_list.append(st["speedSum"]/st["speedCount"])
            speed_all = (sum(speed_all_list)/len(speed_all_list)) if speed_all_list else 0.5
            session_score = round(((0.7*acc_all + 0.3*speed_all) * 100), 1)

            # update mastery per level with smoothing
            for lvl, st in per_level.items():
                if st["total"] <= 0:
                    continue
                acc = st["correct"]/st["total"]
                sp = (st["speedSum"]/st["speedCount"]) if st["speedCount"]>0 else 0.5
                prof = 0.7*acc + 0.3*sp
                m_new = max(1, min(10, int(round(prof*10))))
                old_row = conn.execute("SELECT mastery_1_10 FROM lm_mastery WHERE user_id=? AND level=?", (user["id"], lvl)).fetchone()
                if old_row:
                    old = int(old_row["mastery_1_10"] or 5)
                    m_final = max(1, min(10, int(round(0.7*old + 0.3*m_new))))
                else:
                    m_final = m_new
                conn.execute(
                    "INSERT INTO lm_mastery (user_id, level, mastery_1_10) VALUES (?,?,?) "
                    "ON CONFLICT(user_id, level) DO UPDATE SET mastery_1_10=excluded.mastery_1_10, updated_at=datetime('now')",
                    (user["id"], lvl, m_final),
                )
        except Exception:
            session_score = None
            acc_all = None
            speed_all = None
        conn.commit()
        return jsonify({
            "ok": True,
            "session": {
                "id": sid,
                "estimated_level": estimated_level,
                "correct_total": correct,
                "total_words": total,
                "mastery_1_10": mastery,
                "session_score": session_score,
                "accuracy": acc_all,
                "speed": speed_all,
            }
        })
    finally:
        conn.close()
    # lm_disputes: add error_type
    for stmt in [
        "ALTER TABLE lm_disputes ADD COLUMN error_type TEXT NULL;",
    ]:
        try:
            conn.execute(stmt)
        except sqlite3.OperationalError:
            pass

    # lm_ai_queue
    try:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS lm_ai_queue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                dispute_id INTEGER NOT NULL,
                audio_path TEXT NOT NULL,
                expected TEXT NOT NULL,
                recognized TEXT NULL,
                error_type TEXT NULL,
                status TEXT NOT NULL CHECK(status IN ('queued','exported','deleted')) DEFAULT 'queued',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                exported_at TEXT NULL,
                FOREIGN KEY(dispute_id) REFERENCES lm_disputes(id) ON DELETE CASCADE
            );"""
        )
    except Exception:
        pass



@app.route("/laesemaskine/api/sessions/<int:sid>/audio", methods=["POST"])
def upload_session_audio(sid: int):
    """Upload full session audio ONCE (only when a student disputes a word)."""
    conn = get_db()
    try:
        user, resp = require_login(conn)
        if resp:
            return resp

        sess = conn.execute("SELECT * FROM lm_sessions WHERE id=? AND user_id=?", (sid, user["id"])).fetchone()
        if not sess:
            return jsonify({"error":"session_not_found"}), 404

        if not request.content_type or not request.content_type.startswith("multipart/form-data"):
            return jsonify({"error":"multipart_required"}), 400

        f = request.files.get("audio")
        if not f or not f.filename:
            return jsonify({"error":"missing_audio"}), 400

        mime = (request.form.get("mime") or f.mimetype or "").strip() or None

        ext = os.path.splitext(f.filename)[1].lower()
        if ext not in (".webm",".wav",".ogg",".mp3",".m4a"):
            ext = ".webm"
        fname = f"session_{sid}_{uuid.uuid4().hex}{ext}"
        save_path = UPLOAD_DIR / fname
        f.save(save_path)
        audio_rel = f"uploads/{fname}"

        conn.execute(
            "UPDATE lm_sessions SET session_audio_path=?, session_audio_mime=?, session_audio_uploaded_at=datetime('now') WHERE id=?",
            (audio_rel, mime, sid),
        )
        conn.commit()
        return jsonify({"ok": True, "session_audio_path": audio_rel})
    finally:
        conn.close()


@app.route("/laesemaskine/api/sessions/<int:sid>")
def session_detail(sid: int):
    """Return per-word results for a session (owner or admin)."""
    conn = get_db()
    try:
        user, resp = require_login(conn)
        if resp:
            return resp

        sess = conn.execute("SELECT * FROM lm_sessions WHERE id=?", (sid,)).fetchone()
        if not sess:
            return jsonify({"error":"session_not_found"}), 404

        # permission: owner or admin
        if user["role"] != "admin" and sess["user_id"] != user["id"]:
            return jsonify({"error":"forbidden"}), 403

        items = conn.execute(
            "SELECT id AS session_word_id, word_id, expected, recognized, correct, response_time_ms, visible_ms, created_at, start_ms, end_ms, error_type "
            "FROM lm_session_words WHERE session_id=? ORDER BY id ASC",
            (sid,),
        ).fetchall()

        enriched = []
        for it in items:
            meta = word_meta_by_id(int(it["word_id"])) or {}
            enriched.append({
                "session_word_id": int(it["session_word_id"]),
                "timestamp": it["created_at"],
                "start_ms": it["start_ms"],
                "end_ms": it["end_ms"],
                "word_id": it["word_id"],
                "expected": it["expected"],
                "recognized": it["recognized"],
                "correct": bool(it["correct"]),
                "error_type": (it["error_type"] if "error_type" in it.keys() else None),
                "diagnostics": diagnose_v1(it["expected"], it["recognized"]),
                "response_time_ms": it["response_time_ms"],
                "visible_ms": it["visible_ms"] if "visible_ms" in it.keys() else None,
                "interessekategori": meta.get("interessekategori"),
                "stavemoenster": meta.get("stavemoenster"),
                "ordblind_type": meta.get("ordblind_type"),
                "niveau": meta.get("niveau"),
            })

        return jsonify({
            "ok": True,
            "session": {
                "id": sess["id"],
                "user_id": sess["user_id"],
                "started_at": sess["started_at"],
                "ended_at": sess["ended_at"],
                "estimated_level": sess["estimated_level"],
                "correct_total": sess["correct_total"],
                "total_words": sess["total_words"],
                "feedback_mode": sess["feedback_mode"],
            },
            "items": enriched,
        })
    finally:
        conn.close()

@app.route("/laesemaskine/api/me/sessions")
def my_sessions():
    """List recent sessions for current user."""
    conn = get_db()
    try:
        user, resp = require_login(conn)
        if resp:
            return resp
        rows = conn.execute(
            "SELECT id, started_at, ended_at, estimated_level, correct_total, total_words "
            "FROM lm_sessions WHERE user_id=? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 25",
            (user["id"],),
        ).fetchall()
        return jsonify({"ok": True, "sessions": [dict(r) for r in rows]})
    finally:
        conn.close()

@app.route("/laesemaskine/api/admin/student/<int:uid>/difficulty")
def admin_student_difficulty(uid: int):
    """Aggregate where a student struggles, grouped by categories."""
    conn = get_db()
    try:
        admin, resp = require_admin(conn)
        if resp:
            return resp

        # fetch all session words for student
        rows = conn.execute(
            "SELECT word_id, correct FROM lm_session_words sw "
            "JOIN lm_sessions s ON s.id=sw.session_id "
            "WHERE s.user_id=? AND s.ended_at IS NOT NULL",
            (uid,),
        ).fetchall()

        # aggregate in python using word meta
        by_cat = {}
        by_pattern = {}
        by_obtype = {}

        def add(d, key, correct):
            if not key:
                key = "Ukendt"
            v = d.get(key, {"total":0, "wrong":0})
            v["total"] += 1
            if not correct:
                v["wrong"] += 1
            d[key] = v

        for r in rows:
            meta = word_meta_by_id(int(r["word_id"])) or {}
            correct = bool(r["correct"])
            add(by_cat, meta.get("interessekategori"), correct)
            add(by_pattern, meta.get("stavemoenster"), correct)
            add(by_obtype, meta.get("ordblind_type"), correct)

        def finalize(d):
            out = []
            for k,v in d.items():
                total=v["total"]
                wrong=v["wrong"]
                rate = (wrong/total) if total else 0.0
                out.append({"key": k, "total": total, "wrong": wrong, "wrong_rate": rate})
            out.sort(key=lambda x: (-x["wrong_rate"], -x["wrong"], -x["total"], x["key"]))
            return out[:20]

        return jsonify({
            "ok": True,
            "user_id": uid,
            "by_interessekategori": finalize(by_cat),
            "by_stavemoenster": finalize(by_pattern),
            "by_ordblind_type": finalize(by_obtype),
        })
    finally:
        conn.close()



@app.route("/laesemaskine/api/disputes", methods=["POST"])
def create_dispute():
    """Create a student dispute for a session word.

    Accepts:
      - JSON: {session_word_id, note}
      - multipart/form-data: session_word_id, note, optional audio file (per-word clip)

    If no per-word clip is uploaded but the session has an uploaded session-audio,
    the dispute will link to that session audio so the admin can listen.
    """
    conn = get_db()
    try:
        user, resp = require_login(conn)
        if resp:
            return resp

        is_multipart = bool(request.content_type and request.content_type.startswith("multipart/form-data"))
        if is_multipart:
            session_word_id = int(request.form.get("session_word_id", "0"))
            note = (request.form.get("note") or "").strip() or None
        else:
            data = request.get_json(force=True, silent=True) or {}
            session_word_id = int(data.get("session_word_id", 0))
            note = (data.get("note") or "").strip() or None

        if session_word_id <= 0:
            return jsonify({"error": "missing_session_word_id"}), 400

        sw = conn.execute(
            "SELECT sw.id, sw.session_id, sw.expected, sw.recognized, sw.error_type, sw.start_ms, sw.end_ms, "
            "s.user_id, s.session_audio_path "
            "FROM lm_session_words sw JOIN lm_sessions s ON s.id=sw.session_id "
            "WHERE sw.id=?",
            (session_word_id,),
        ).fetchone()
        if not sw:
            return jsonify({"error": "session_word_not_found"}), 404

        if user["role"] != "admin" and sw["user_id"] != user["id"]:
            return jsonify({"error": "forbidden"}), 403

        audio_rel = None

        # Optional per-word clip upload
        if is_multipart:
            f = request.files.get("audio")
            if f and f.filename:
                ext = os.path.splitext(f.filename)[1].lower()
                if ext not in (".webm", ".wav", ".ogg", ".mp3", ".m4a"):
                    ext = ".webm"
                fname = f"dispute_{session_word_id}_{uuid.uuid4().hex}{ext}"
                save_path = UPLOAD_DIR / fname
                f.save(save_path)
                audio_rel = f"uploads/{fname}"

        # Fallback: link to session audio if available
        if not audio_rel and sw["session_audio_path"]:
            audio_rel = sw["session_audio_path"]

        cur = conn.execute(
            "INSERT INTO lm_disputes (session_word_id, session_id, student_user_id, expected, recognized, note, audio_path, error_type) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (sw["id"], sw["session_id"], sw["user_id"], sw["expected"], sw["recognized"], note, audio_rel, sw["error_type"]),
        )
        did = cur.lastrowid
        conn.commit()
        return jsonify({"ok": True, "dispute_id": did, "audio_path": audio_rel})
    finally:
        conn.close()


@app.route("/laesemaskine/api/admin/disputes")
def admin_list_disputes():
    conn = get_db()
    try:
        admin, resp = require_admin(conn)
        if resp:
            return resp
        rows = conn.execute(
            "SELECT d.id, d.status, d.created_at, d.note, d.audio_path, "
            "u.username AS student, u.display_name AS student_name, d.expected, d.recognized, d.session_word_id, d.session_id "
            "FROM lm_disputes d JOIN lm_users u ON u.id=d.student_user_id "
            "ORDER BY d.created_at DESC LIMIT 200"
        ).fetchall()
        return jsonify({"ok": True, "disputes": [dict(r) for r in rows]})
    finally:
        conn.close()

@app.route("/laesemaskine/api/admin/disputes/<int:did>", methods=["PATCH"])
def admin_review_dispute(did: int):
    conn = get_db()
    try:
        admin, resp = require_admin(conn)
        if resp:
            return resp
        data = request.get_json(force=True, silent=True) or {}
        status = (data.get("status") or "").strip()
        if status not in ("approved","rejected","pending"):
            return jsonify({"error":"invalid_status"}), 400
        conn.execute(
            "UPDATE lm_disputes SET status=?, reviewed_by=?, reviewed_at=datetime('now') WHERE id=?",
            (status, admin["id"], did),
        )
        row2 = conn.execute("SELECT id, audio_path, expected, recognized, error_type FROM lm_disputes WHERE id=?", (did,)).fetchone()
        # Only enqueue if explicitly approved here (optional; main flow uses /send_to_ai)
        if status == 'approved' and row2 and row2["audio_path"]:
            conn.execute(
                "INSERT INTO lm_ai_queue (dispute_id, audio_path, expected, recognized, error_type) VALUES (?,?,?,?,?)",
                (did, row2["audio_path"], row2["expected"], row2["recognized"], row2["error_type"]),
            )
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()



@app.route("/laesemaskine/api/admin/disputes/<int:did>/audio", methods=["DELETE"])
def admin_delete_dispute_audio(did: int):
    conn = get_db()
    try:
        admin, resp = require_admin(conn)
        if resp:
            return resp
        row = conn.execute("SELECT audio_path FROM lm_disputes WHERE id=?", (did,)).fetchone()
        if not row:
            return jsonify({"error":"not_found"}), 404
        audio_path = row["audio_path"]
        if audio_path:
            try:
                fname = audio_path.split("/", 1)[1] if "/" in audio_path else audio_path
                fpath = UPLOAD_DIR / fname
                if fpath.exists():
                    fpath.unlink()
            except Exception:
                pass
        conn.execute("UPDATE lm_disputes SET audio_path=NULL WHERE id=?", (did,))
        row2 = conn.execute("SELECT id, audio_path, expected, recognized, error_type FROM lm_disputes WHERE id=?", (did,)).fetchone()
        # Only enqueue if explicitly approved here (optional; main flow uses /send_to_ai)
        if status == 'approved' and row2 and row2["audio_path"]:
            conn.execute(
                "INSERT INTO lm_ai_queue (dispute_id, audio_path, expected, recognized, error_type) VALUES (?,?,?,?,?)",
                (did, row2["audio_path"], row2["expected"], row2["recognized"], row2["error_type"]),
            )
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()


@app.route("/laesemaskine/api/admin/disputes/<int:did>/send_to_ai", methods=["POST"])
def admin_send_dispute_to_ai(did: int):
    # MVP stub: mark as approved and "queued" for AI training.
    # Real implementation would enqueue a job with audio + expected word.
    conn = get_db()
    try:
        admin, resp = require_admin(conn)
        if resp:
            return resp
        row = conn.execute("SELECT id FROM lm_disputes WHERE id=?", (did,)).fetchone()
        if not row:
            return jsonify({"error":"not_found"}), 404
        payload = request.get_json(silent=True) or {}
        sel_error_type = payload.get('error_type')
        conn.execute(
            "UPDATE lm_disputes SET status='approved', error_type=COALESCE(?, error_type), reviewed_by=?, reviewed_at=datetime('now') WHERE id=?",
            (sel_error_type, admin["id"], did),
        )
        row2 = conn.execute("SELECT id, audio_path, expected, recognized, error_type FROM lm_disputes WHERE id=?", (did,)).fetchone()
        # Only enqueue if explicitly approved here (optional; main flow uses /send_to_ai)
        if status == 'approved' and row2 and row2["audio_path"]:
            conn.execute(
                "INSERT INTO lm_ai_queue (dispute_id, audio_path, expected, recognized, error_type) VALUES (?,?,?,?,?)",
                (did, row2["audio_path"], row2["expected"], row2["recognized"], row2["error_type"]),
            )
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()

@app.route("/laesemaskine/uploads/<path:filename>")
def serve_upload(filename: str):
    # simple static serving for admin review (lock down in real deployment)
    return send_from_directory(str(UPLOAD_DIR), filename)


@app.route("/laesemaskine/api/admin/student/<int:uid>/drilldown")
def admin_student_drilldown(uid: int):
    """Return word-level attempts for one grouping key (interessekategori/stavemoenster/ordblind_type)."""
    conn = get_db()
    try:
        admin, resp = require_admin(conn)
        if resp:
            return resp

        group = (request.args.get("group") or "").strip()
        key = (request.args.get("key") or "").strip()
        if group not in ("interessekategori", "stavemoenster", "ordblind_type"):
            return jsonify({"error": "invalid_group"}), 400
        if not key:
            return jsonify({"error": "missing_key"}), 400

        rows = conn.execute(
            "SELECT sw.word_id, sw.expected, sw.recognized, sw.correct, sw.response_time_ms, sw.created_at, sw.session_id "
            "FROM lm_session_words sw "
            "JOIN lm_sessions s ON s.id=sw.session_id "
            "WHERE s.user_id=? AND s.ended_at IS NOT NULL "
            "ORDER BY sw.created_at DESC LIMIT 300",
            (uid,),
        ).fetchall()

        out = []
        for r in rows:
            meta = word_meta_by_id(int(r["word_id"])) or {}
            val = meta.get(group) or "Ukendt"
            if val != key:
                continue
            out.append({
                "word_id": r["word_id"],
                "expected": r["expected"],
                "recognized": r["recognized"],
                "correct": bool(r["correct"]),
                "response_time_ms": r["response_time_ms"],
                "timestamp": r["created_at"],
                "session_id": r["session_id"],
                "niveau": meta.get("niveau"),
            })

        # newest first
        return jsonify({"ok": True, "group": group, "key": key, "items": out})
    finally:
        conn.close()

# Admin endpoints
@app.route("/laesemaskine/api/admin/groups", methods=["GET","POST"])
def admin_groups():
    conn = get_db()
    try:
        admin, resp = require_admin(conn)
        if resp:
            return resp

        if request.method == "POST":
            data = request.get_json(force=True, silent=True) or {}
            name = (data.get("name") or "").strip()
            if not name:
                return jsonify({"error":"missing_name"}), 400
            cur = conn.execute("INSERT INTO lm_groups (name) VALUES (?)", (name,))
            conn.commit()
            return jsonify({"ok": True, "group": {"id": cur.lastrowid, "name": name}})
        groups = conn.execute("SELECT * FROM lm_groups ORDER BY created_at DESC").fetchall()
        return jsonify({"ok": True, "groups": [dict(g) for g in groups]})
    finally:
        conn.close()

@app.route("/laesemaskine/api/admin/groups/<int:gid>", methods=["PATCH"])
def admin_group_rename(gid: int):
    conn = get_db()
    try:
        admin, resp = require_admin(conn)
        if resp:
            return resp
        data = request.get_json(force=True, silent=True) or {}
        name = (data.get("name") or "").strip()
        if not name:
            return jsonify({"error":"missing_name"}), 400
        conn.execute("UPDATE lm_groups SET name=? WHERE id=?", (name, gid))
        row2 = conn.execute("SELECT id, audio_path, expected, recognized, error_type FROM lm_disputes WHERE id=?", (did,)).fetchone()
        # Only enqueue if explicitly approved here (optional; main flow uses /send_to_ai)
        if status == 'approved' and row2 and row2["audio_path"]:
            conn.execute(
                "INSERT INTO lm_ai_queue (dispute_id, audio_path, expected, recognized, error_type) VALUES (?,?,?,?,?)",
                (did, row2["audio_path"], row2["expected"], row2["recognized"], row2["error_type"]),
            )
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()

@app.route("/laesemaskine/api/admin/users", methods=["GET","POST"])
def admin_users():
    conn = get_db()
    try:
        admin, resp = require_admin(conn)
        if resp:
            return resp

        if request.method == "POST":
            data = request.get_json(force=True, silent=True) or {}
            username = (data.get("username") or "").strip()
            password = (data.get("password") or "").strip()
            group_id = data.get("group_id")
            display_name = (data.get("display_name") or "").strip() or None
            if not username or not password:
                return jsonify({"error":"missing_username_or_password"}), 400
            if group_id is not None:
                try:
                    group_id = int(group_id)
                except ValueError:
                    group_id = None
            pw_hash = generate_password_hash(password)
            try:
                conn.execute(
                    "INSERT INTO lm_users (username, password_hash, role, group_id, display_name) VALUES (?,?,?,?,?)",
                    (username, pw_hash, "elev", group_id, display_name),
                )
                conn.commit()
            except sqlite3.IntegrityError:
                return jsonify({"error":"username_taken"}), 409
            return jsonify({"ok": True})
        # list users
        users = conn.execute(
            "SELECT u.id, u.username, u.role, u.group_id, u.display_name, g.name AS group_name, u.created_at "
            "FROM lm_users u LEFT JOIN lm_groups g ON g.id=u.group_id ORDER BY u.created_at DESC"
        ).fetchall()
        return jsonify({"ok": True, "users": [dict(u) for u in users]})
    finally:
        conn.close()

@app.route("/laesemaskine/api/admin/overview")
def admin_overview():
    conn = get_db()
    try:
        admin, resp = require_admin(conn)
        if resp:
            return resp

        # per user current estimated level (last session)
        rows = conn.execute(
            "SELECT u.id, u.username, u.display_name, g.name AS group_name, "
            "(SELECT estimated_level FROM lm_sessions s WHERE s.user_id=u.id AND s.ended_at IS NOT NULL ORDER BY s.ended_at DESC LIMIT 1) AS last_level, "
            "(SELECT mastery_1_10 FROM lm_mastery m WHERE m.user_id=u.id AND m.level = (SELECT estimated_level FROM lm_sessions s2 WHERE s2.user_id=u.id AND s2.ended_at IS NOT NULL ORDER BY s2.ended_at DESC LIMIT 1) LIMIT 1) AS last_mastery "
            "FROM lm_users u LEFT JOIN lm_groups g ON g.id=u.group_id "
            "WHERE u.role='elev' ORDER BY u.created_at DESC"
        ).fetchall()
        return jsonify({"ok": True, "students": [dict(r) for r in rows]})
    finally:
        conn.close()

# Static frontend routes
@app.route("/laesemaskine/")
def serve_index():
    return send_from_directory(app.static_folder, "index.html")

@app.route("/laesemaskine/<path:filename>")
def serve_static(filename: str):
    # allow direct access to html/css/js
    return send_from_directory(app.static_folder, filename)

if __name__ == "__main__":
    init_db()
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=True)

