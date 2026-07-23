#!/usr/bin/env python3
"""
Test script to verify bot starts properly from web UI
"""

import time

from database.telegram_db import get_bot_config
from services.telegram_bot_service import telegram_bot_service

if __name__ == "__main__":
    # Get config
    config = get_bot_config()

    if not config.get("token"):
        print("[ERROR] No bot token configured")
        exit(1)

    print(f"[INFO] Bot token found: {config['token'][:10]}...")

    # Initialize bot
    print("[INFO] Initializing bot...")
    success, message = telegram_bot_service.initialize_bot_sync(token=config["token"])

    if not success:
        print(f"[ERROR] Failed to initialize: {message}")
        exit(1)

    print(f"[OK] {message}")

    # Start bot
    print("[INFO] Starting bot in polling mode...")
    success, message = telegram_bot_service.start_bot()

    if not success:
        print(f"[ERROR] Failed to start: {message}")
        exit(1)

    print(f"[OK] {message}")

    # Check status
    print(f"[STATUS] Bot running: {telegram_bot_service.is_running}")

    # Keep running for testing
    print("[INFO] Bot is running. Press Ctrl+C to stop.")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[INFO] Stopping bot...")
        success, message = telegram_bot_service.stop_bot()
        print(f"[OK] {message}")


