"""Telegram 알림 — best-effort, 토큰 없거나 실패해도 조용히."""
from __future__ import annotations

import os
import urllib.parse
import urllib.request

TELEGRAM_MAX_TEXT = 4000


def push(message: str, *, timeout: int = 10) -> bool:
    """TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID 환경변수로 메시지 전송.

    돌려주는 값은 "전송 시도가 정상 종료됐는지" (네트워크 에러 없었는지).
    토큰이 비어 있으면 False 를 반환하고 아무것도 하지 않는다.
    """
    token = (os.environ.get("TELEGRAM_BOT_TOKEN") or "").strip()
    chat = (os.environ.get("TELEGRAM_CHAT_ID") or "").strip()
    if not token or not chat:
        return False
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    data = urllib.parse.urlencode({
        "chat_id": chat,
        "text": (message or "")[:TELEGRAM_MAX_TEXT],
    }).encode("utf-8")
    try:
        req = urllib.request.Request(url, data=data, method="POST")
        urllib.request.urlopen(req, timeout=timeout).read()
        return True
    except Exception:
        return False
