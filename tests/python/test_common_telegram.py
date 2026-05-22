"""_common.telegram BDD 시나리오 (네트워크 호출 없음)."""
from __future__ import annotations

from _common import telegram


def test_push는_토큰_없을_때_False를_반환하고_네트워크를_치지_않는다(monkeypatch):
    # Given: 환경변수 비어있음
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    monkeypatch.delenv("TELEGRAM_CHAT_ID", raising=False)

    # When: push
    ok = telegram.push("hello")

    # Then: False (네트워크는 호출되지 않았어야 함 — 검증은 fakeurlopen 으로 후속)
    assert ok is False


def test_push는_chat_id_없으면_False(monkeypatch):
    # Given: 토큰만 있음, chat 없음
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "secret")
    monkeypatch.delenv("TELEGRAM_CHAT_ID", raising=False)
    # When: push
    ok = telegram.push("hello")
    # Then: False
    assert ok is False
