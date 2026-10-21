#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""文件柜 —— 管理后台（需登录）+ 访客配对码取件"""
import os
import json
import time
import stat
import shutil
import sqlite3
import hashlib
import secrets
import functools
from pathlib import Path

from flask import (
    Flask, request, session, redirect, url_for,
    render_template, send_file, jsonify, abort,
)
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

BASE_DIR = Path(__file__).resolve().parent
CONFIG_FILE = BASE_DIR / "config.json"
SECRET_FILE = BASE_DIR / "secret.key"
DB_FILE = BASE_DIR / "codes.db"
STAGING = Path(os.environ.get("FILE_CAB_STAGING", "/data/staging"))
MAX_PREVIEW = 2 * 1024 * 1024
MAX_UPLOAD = 4 * 1024 * 1024 * 1024

app = Flask(__name__, static_folder="static", template_folder="templates")
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_SECURE"] = True
app.config["PERMANENT_SESSION_LIFETIME"] = 60 * 60 * 12

if not SECRET_FILE.exists():
    SECRET_FILE.write_text(secrets.token_hex(32))
    os.chmod(SECRET_FILE, 0o600)
app.secret_key = SECRET_FILE.read_text().strip()
signer = URLSafeTimedSerializer(app.secret_key, salt="pickup")

STAGING.mkdir(parents=True, exist_ok=True)


# ---------------- 数据库 ----------------
def db():
    conn = sqlite3.connect(DB_FILE, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with db() as c:
        c.execute("""
        CREATE TABLE IF NOT EXISTS codes (
            code TEXT PRIMARY KEY,
            file_path TEXT NOT NULL,
            note TEXT DEFAULT '',
            created_at INTEGER NOT NULL,
            expires_at INTEGER DEFAULT 0,
            max_downloads INTEGER DEFAULT 0,
            downloads INTEGER DEFAULT 0,
            disabled INTEGER DEFAULT 0
        )""")


init_db()


# ---------------- 认证 ----------------
_attempts = {}
MAX_ATTEMPTS = 6
WINDOW = 300


def load_config():
    with open(CONFIG_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def site_info():
    """站点展示信息（群号等），全部可选"""
    try:
        return load_config().get("site", {}) or {}
    except Exception:
        return {}


def verify(user, password):
    acct = load_config().get("users", {}).get(user)
    if not acct:
        return False
    calc = hashlib.pbkdf2_hmac(
        "sha256", password.encode(), bytes.fromhex(acct["salt"]), acct["iterations"]
    ).hex()
    return secrets.compare_digest(calc, acct["hash"])


def rate_limited(ip):
    now = time.time()
    arr = [t for t in _attempts.get(ip, []) if now - t < WINDOW]
    _attempts[ip] = arr
    return len(arr) >= MAX_ATTEMPTS


def login_required(fn):
    @functools.wraps(fn)
    def wrapper(*a, **kw):
        if not session.get("user"):
            if request.path.startswith("/api/"):
                return jsonify(ok=False, error="未登录"), 401
            return redirect(url_for("login_page"))
        return fn(*a, **kw)
    return wrapper


def csrf_ok():
    token = session.get("csrf")
    return bool(token) and request.headers.get("X-CSRF") == token


def require_csrf():
    if not csrf_ok():
        abort(403)


def client_ip():
    return request.headers.get("X-Real-IP", request.remote_addr or "-")


# ---------------- 通用 ----------------
def human_size(n):
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024.0


def safe_name(name):
    name = (name or "").replace("\\", "/").split("/")[-1].strip()
    if name in ("", ".", ".."):
        return None
    return name


def unique_path(target: Path) -> Path:
    if not target.exists():
        return target
    stem, suffix = target.stem, target.suffix
    i = 1
    while True:
        cand = target.with_name(f"{stem} ({i}){suffix}")
        if not cand.exists():
            return cand
        i += 1


def staging_path(name):
    n = safe_name(name)
    if not n:
        abort(400)
    p = (STAGING / n).resolve()
    if STAGING.resolve() not in p.parents and p != STAGING.resolve():
        abort(400)
    return p


def list_dir(path: Path, show_hidden=True):
    entries = []
    try:
        with os.scandir(path) as it:
            for e in it:
                if not show_hidden and e.name.startswith("."):
                    continue
                try:
                    st = e.stat(follow_symlinks=False)
                except OSError:
                    continue
                is_dir = e.is_dir(follow_symlinks=False)
                entries.append({
                    "name": e.name,
                    "path": str(Path(e.path)),
                    "dir": is_dir,
                    "link": e.is_symlink(),
                    "size": 0 if is_dir else st.st_size,
                    "size_h": "—" if is_dir else human_size(st.st_size),
                    "mtime": int(st.st_mtime),
                    "mode": oct(stat.S_IMODE(st.st_mode))[2:],
                })
    except PermissionError:
        abort(403)
    entries.sort(key=lambda x: (not x["dir"], x["name"].lower()))
    return entries


# ---------------- 访客页面 ----------------
@app.get("/")
def public_page():
    info = site_info()
    return render_template(
        "public.html",
        group_no=os.environ.get("FILE_CAB_GROUP", info.get("group", "")),
    )


@app.post("/api/public/lookup")
def public_lookup():
    ip = client_ip()
    now = time.time()
    hits = [t for t in _attempts.get("pub:" + ip, []) if now - t < 3600]
    if len(hits) >= 40:
        return jsonify(ok=False, error="尝试过于频繁，请稍后再试"), 429
    recent = [t for t in hits if now - t < 60]
    if len(recent) >= 12:
        return jsonify(ok=False, error="操作太频繁，请 1 分钟后再试"), 429
    _attempts["pub:" + ip] = hits + [now]

    code = (request.get_json(force=True).get("code") or "").strip()
    if not (len(code) == 4 and code.isdigit()):
        return jsonify(ok=False, error="请输入 4 位数字配对码"), 400

    with db() as c:
        row = c.execute("SELECT * FROM codes WHERE code=?", (code,)).fetchone()

    if not row or row["disabled"]:
        return jsonify(ok=False, error="配对码无效，请核对后重试"), 404
    if row["expires_at"] and row["expires_at"] < now:
        return jsonify(ok=False, error="该配对码已过期"), 410
    if row["max_downloads"] and row["downloads"] >= row["max_downloads"]:
        return jsonify(ok=False, error="该配对码下载次数已用完"), 410

    p = Path(row["file_path"])
    if not p.is_file():
        return jsonify(ok=False, error="文件已被移除，请联系管理员"), 410

    token = signer.dumps({"code": code, "path": str(p), "n": secrets.token_hex(4)})
    return jsonify(
        ok=True,
        name=p.name,
        size_h=human_size(p.stat().st_size),
        note=row["note"] or "",
        expires_at=row["expires_at"],
        remaining=(row["max_downloads"] - row["downloads"]) if row["max_downloads"] else None,
        token=token,
    )


@app.get("/api/public/download")
def public_download():
    t = request.args.get("t", "")
    try:
        data = signer.loads(t, max_age=900)
    except SignatureExpired:
        abort(410, "链接已过期，请重新输入配对码")
    except BadSignature:
        abort(403)
    p = Path(data["path"])
    if not p.is_file():
        abort(404)
    with db() as c:
        c.execute("UPDATE codes SET downloads = downloads + 1 WHERE code=?", (data["code"],))
    return send_file(p, as_attachment=True, download_name=p.name)


# ---------------- 登录 ----------------
@app.get("/login")
def login_page():
    if session.get("user"):
        return redirect(url_for("admin_page"))
    return render_template("login.html")


@app.post("/login")
def do_login():
    ip = client_ip()
    if rate_limited(ip):
        return render_template("login.html", error="尝试次数过多，请 5 分钟后再试", user="")
    user = (request.form.get("username") or "").strip()
    pwd = request.form.get("password") or ""
    if not verify(user, pwd):
        _attempts.setdefault(ip, []).append(time.time())
        time.sleep(0.6)
        return render_template("login.html", error="用户名或密码不正确", user=user)
    _attempts.pop(ip, None)
    session.clear()
    session.permanent = True
    session["user"] = user
    session["csrf"] = secrets.token_urlsafe(24)
    return redirect(url_for("admin_page"))


@app.post("/logout")
@login_required
def logout():
    session.clear()
    return jsonify(ok=True)


# ---------------- 管理后台 ----------------
@app.get("/admin")
@login_required
def admin_page():
    if "csrf" not in session:
        session["csrf"] = secrets.token_urlsafe(24)
    return render_template("index.html", user=session["user"], csrf=session["csrf"])


@app.get("/api/fs")
@login_required
def api_fs():
    raw = request.args.get("path", "/")
    p = Path(raw)
    if not p.is_absolute():
        abort(400)
    p = p.resolve()
    if not p.exists() or not p.is_dir():
        abort(404)
    parent = str(p.parent) if str(p) != "/" else None
    return jsonify(ok=True, path=str(p), parent=parent,
                   entries=list_dir(p, show_hidden=request.args.get("hidden") == "1"))


@app.post("/api/fs/mkdir")
@login_required
def api_mkdir():
    require_csrf()
    data = request.get_json(force=True)
    base = Path(data["dir"]).resolve()
    name = safe_name(data.get("name"))
    if not name:
        abort(400)
    target = base / name
    target.mkdir(parents=False, exist_ok=False)
    return jsonify(ok=True, path=str(target))


@app.post("/api/fs/rename")
@login_required
def api_rename():
    require_csrf()
    data = request.get_json(force=True)
    src = Path(data["path"]).resolve()
    name = safe_name(data.get("name"))
    if not name:
        abort(400)
    dst = src.with_name(name)
    if dst.exists():
        return jsonify(ok=False, error="同名文件已存在"), 400
    src.rename(dst)
    return jsonify(ok=True, path=str(dst))


@app.post("/api/fs/delete")
@login_required
def api_delete():
    require_csrf()
    data = request.get_json(force=True)
    done = []
    for raw in data.get("paths", []):
        p = Path(raw)
        if not p.is_absolute() or str(p.resolve()) == "/":
            continue
        p = p.resolve()
        if p.is_dir() and not p.is_symlink():
            shutil.rmtree(p)
        elif p.exists() or p.is_symlink():
            p.unlink()
        done.append(str(p))
    return jsonify(ok=True, deleted=done)


@app.post("/api/fs/upload")
@login_required
def api_upload():
    require_csrf()
    base = Path(request.form.get("dir", "/")).resolve()
    saved = []
    for f in request.files.getlist("files"):
        name = safe_name(f.filename)
        if not name:
            continue
        target = unique_path(base / name)
        f.save(target)
        saved.append({"name": target.name, "size": target.stat().st_size})
    return jsonify(ok=True, files=saved)


@app.get("/api/fs/download")
@login_required
def api_download():
    p = Path(request.args.get("path", "")).resolve()
    if not p.is_file():
        abort(404)
    return send_file(p, as_attachment=True, download_name=p.name)


@app.get("/api/fs/read")
@login_required
def api_read():
    p = Path(request.args.get("path", "")).resolve()
    if not p.is_file():
        abort(404)
    if p.stat().st_size > MAX_PREVIEW:
        return jsonify(ok=False, error="文件过大，无法预览"), 400
    raw = p.read_bytes()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return jsonify(ok=False, error="二进制文件，无法以文本打开"), 400
    return jsonify(ok=True, path=str(p), content=text, size=p.stat().st_size)


@app.post("/api/fs/write")
@login_required
def api_write():
    require_csrf()
    data = request.get_json(force=True)
    p = Path(data["path"]).resolve()
    if not p.is_file():
        abort(404)
    p.write_text(data.get("content", ""), encoding="utf-8")
    return jsonify(ok=True, size=p.stat().st_size)


# ---------------- 暂存区 ----------------
@app.get("/api/staging")
@login_required
def api_staging_list():
    entries = list_dir(STAGING)
    total = sum(e["size"] for e in entries)
    return jsonify(ok=True, entries=entries, total=total, total_h=human_size(total),
                   capacity_h=human_size(shutil.disk_usage(STAGING).free) + " 可用")


@app.post("/api/staging/upload")
@login_required
def api_staging_upload():
    require_csrf()
    saved = []
    for f in request.files.getlist("files"):
        name = safe_name(f.filename)
        if not name:
            continue
        target = unique_path(STAGING / name)
        f.save(target)
        saved.append({"name": target.name, "size": target.stat().st_size})
    return jsonify(ok=True, files=saved)


@app.post("/api/staging/delete")
@login_required
def api_staging_delete():
    require_csrf()
    for name in request.get_json(force=True).get("names", []):
        p = staging_path(name)
        if p.is_file() or p.is_symlink():
            p.unlink()
        elif p.is_dir():
            shutil.rmtree(p)
    return jsonify(ok=True)


@app.get("/api/staging/download")
@login_required
def api_staging_download():
    p = staging_path(request.args.get("name", ""))
    if not p.is_file():
        abort(404)
    return send_file(p, as_attachment=True, download_name=p.name)


@app.post("/api/staging/from-server")
@login_required
def api_staging_from_server():
    require_csrf()
    src = Path(request.get_json(force=True).get("path", "")).resolve()
    if not src.is_file():
        abort(404)
    target = unique_path(STAGING / src.name)
    shutil.copy2(src, target)
    return jsonify(ok=True, name=target.name, size=target.stat().st_size)


# ---------------- 配对码管理 ----------------
@app.get("/api/codes")
@login_required
def api_codes_list():
    now = int(time.time())
    with db() as c:
        rows = c.execute("SELECT * FROM codes ORDER BY created_at DESC").fetchall()
    out = []
    for r in rows:
        p = Path(r["file_path"])
        out.append({
            "code": r["code"],
            "file": p.name,
            "path": r["file_path"],
            "exists": p.is_file(),
            "size_h": human_size(p.stat().st_size) if p.is_file() else "—",
            "note": r["note"],
            "created_at": r["created_at"],
            "expires_at": r["expires_at"],
            "expired": bool(r["expires_at"] and r["expires_at"] < now),
            "max_downloads": r["max_downloads"],
            "downloads": r["downloads"],
            "disabled": bool(r["disabled"]),
        })
    return jsonify(ok=True, codes=out)


def gen_code():
    with db() as c:
        for _ in range(50):
            code = f"{secrets.randbelow(10000):04d}"
            if not c.execute("SELECT 1 FROM codes WHERE code=?", (code,)).fetchone():
                return code
    return None


@app.post("/api/codes")
@login_required
def api_codes_create():
    require_csrf()
    data = request.get_json(force=True)
    name = safe_name(data.get("file"))
    if not name:
        return jsonify(ok=False, error="请选择一个文件"), 400
    p = staging_path(name)
    if not p.is_file():
        return jsonify(ok=False, error="文件不存在"), 404

    code = (data.get("code") or "").strip()
    if code:
        if not (len(code) == 4 and code.isdigit()):
            return jsonify(ok=False, error="配对码必须是 4 位数字"), 400
        with db() as c:
            if c.execute("SELECT 1 FROM codes WHERE code=?", (code,)).fetchone():
                return jsonify(ok=False, error="该配对码已存在"), 400
    else:
        code = gen_code()
        if not code:
            return jsonify(ok=False, error="生成失败，请重试"), 500

    hours = int(data.get("expire_hours") or 0)
    expires_at = int(time.time()) + hours * 3600 if hours > 0 else 0
    max_dl = int(data.get("max_downloads") or 0)

    with db() as c:
        c.execute(
            "INSERT INTO codes(code,file_path,note,created_at,expires_at,max_downloads) VALUES(?,?,?,?,?,?)",
            (code, str(p), (data.get("note") or "").strip()[:80], int(time.time()), expires_at, max_dl),
        )
    return jsonify(ok=True, code=code)


@app.post("/api/codes/toggle")
@login_required
def api_codes_toggle():
    require_csrf()
    data = request.get_json(force=True)
    with db() as c:
        c.execute("UPDATE codes SET disabled = 1 - disabled WHERE code=?", (data.get("code"),))
    return jsonify(ok=True)


@app.post("/api/codes/delete")
@login_required
def api_codes_delete():
    require_csrf()
    with db() as c:
        c.execute("DELETE FROM codes WHERE code=?", (request.get_json(force=True).get("code"),))
    return jsonify(ok=True)


@app.errorhandler(413)
def too_large(_):
    return jsonify(ok=False, error="文件超过 4GB 上限"), 413


@app.errorhandler(403)
def forbidden(_):
    return jsonify(ok=False, error="请求被拒绝（CSRF 或权限）"), 403


@app.errorhandler(400)
def bad_request(e):
    if request.path.startswith("/api/"):
        return jsonify(ok=False, error=getattr(e, "description", "请求参数有误")), 400
    return e


@app.errorhandler(410)
def gone(e):
    if request.path.startswith("/api/"):
        return jsonify(ok=False, error=getattr(e, "description", "内容已失效")), 410
    return e


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8090, debug=False)
