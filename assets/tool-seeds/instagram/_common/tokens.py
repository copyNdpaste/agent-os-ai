"""tokens.json 로드/저장 + 만료 계산 + token_manager 트리거."""
from __future__ import annotations

import datetime as dt
import json
import os
import subprocess
import sys
from typing import Optional


def load(path: str) -> dict:
    """tokens.json 로드. 파일 없거나 손상이면 빈 dict."""
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f) or {}
    except Exception:
        return {}


def save(path: str, tokens: dict) -> None:
    """원자적 저장(.tmp → rename) + 0600 권한."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(tokens, f, ensure_ascii=False, indent=2, sort_keys=True)
    os.replace(tmp, path)
    try:
        os.chmod(path, 0o600)
    except Exception:
        pass


def _parse_iso(iso: str) -> Optional[dt.datetime]:
    if not iso:
        return None
    try:
        s = iso[:-1] if iso.endswith("Z") else iso
        return dt.datetime.fromisoformat(s)
    except Exception:
        return None


def _utcnow_naive() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)


def days_until(iso: str) -> Optional[float]:
    """주어진 ISO 시각까지 남은 일수. 파싱 실패하면 None.

    Threads/Instagram 같은 장기 토큰(60일)용. 음수면 이미 만료된 상태.
    """
    parsed = _parse_iso(iso)
    if parsed is None:
        return None
    return (parsed - _utcnow_naive()).total_seconds() / 86400.0


def seconds_until(iso: str) -> Optional[float]:
    """남은 초. X 같은 단기 토큰(2시간)용."""
    parsed = _parse_iso(iso)
    if parsed is None:
        return None
    return (parsed - _utcnow_naive()).total_seconds()


def trigger_refresh(token_manager_path: str, *, timeout: int = 60) -> bool:
    """token_manager.py --refresh 실행. 성공 여부를 bool 로 반환.

    실패해도 예외 던지지 않음 — caller 가 다음 단계(inline refresh 등) 결정.
    """
    if not os.path.isfile(token_manager_path):
        return False
    try:
        subprocess.run(
            [sys.executable, token_manager_path, "--refresh"],
            timeout=timeout,
            capture_output=True,
        )
        return True
    except Exception:
        return False
