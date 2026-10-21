#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 config.json：写入管理员账号（PBKDF2 哈希）与可选展示信息"""
import json
import os
import sys
import getpass
import hashlib
import secrets
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "config.json"
ITERATIONS = 240000


def main():
    if TARGET.exists():
        ans = input(f"{TARGET} 已存在，覆盖？[y/N] ").strip().lower()
        if ans != "y":
            print("已取消")
            return

    username = input("管理员用户名: ").strip()
    if not username:
        print("用户名不能为空")
        sys.exit(1)
    password = getpass.getpass("管理员密码: ")
    if len(password) < 6:
        print("密码至少 6 位")
        sys.exit(1)
    if password != getpass.getpass("再输入一次: "):
        print("两次输入不一致")
        sys.exit(1)

    group = input("访客页展示的联系群号（可留空）: ").strip()

    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), ITERATIONS).hex()

    cfg = {
        "users": {username: {"salt": salt, "iterations": ITERATIONS, "hash": digest}},
        "site": {"group": group},
    }
    TARGET.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    os.chmod(TARGET, 0o600)
    print(f"已生成 {TARGET}（权限 600）")


if __name__ == "__main__":
    main()
