"""플랫폼별 자격증명 해석.

각 uploader 의 _resolve_credentials 가 거의 동일한 흐름이라 spec 기반으로 통합:
    1) tokens.json[platform_key][account] 확인
    2) 만료 임박 → token_manager --refresh 호출 후 재로딩
    3) env fallback (플랫폼별 키)
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Callable, Optional

from . import tokens as tokens_mod


@dataclass(frozen=True)
class CredentialSpec:
    """플랫폼별 자격증명 사양.

    platform_key:  tokens.json 의 최상위 키 (예: "instagram", "threads", "x")
    field_names:   tokens.json info 에서 필수 필드명들 (예: ["access_token", "user_id"])
    env_fallback:  env 변수명 매핑 — field_names 와 동일 길이
                   None 항목은 fallback 없음을 의미
    refresh_threshold_days:    days_until 사용 (장기 토큰)
    refresh_threshold_seconds: seconds_until 사용 (단기 토큰, X 등)
    """
    platform_key: str
    field_names: tuple
    env_fallback: tuple
    refresh_threshold_days: Optional[float] = None
    refresh_threshold_seconds: Optional[float] = None


def resolve(
    account: str,
    spec: CredentialSpec,
    *,
    tokens_path: str,
    token_manager_path: str,
    trigger_refresh: Callable[[], bool] = None,
) -> tuple:
    """자격증명을 (*field_values, source) 형태로 반환.

    source 값: "tokens.json" | "env" | "none"
    필드를 못 찾으면 빈 문자열들 + "none".
    """
    assert len(spec.field_names) == len(spec.env_fallback), \
        "field_names 와 env_fallback 길이가 같아야 합니다"

    do_refresh = trigger_refresh or (
        lambda: tokens_mod.trigger_refresh(token_manager_path)
    )

    tokens = tokens_mod.load(tokens_path)
    section = (tokens.get(spec.platform_key) or {})
    info = section.get(account)

    def _info_has_all(d: dict) -> bool:
        return bool(d) and all(d.get(f) for f in spec.field_names)

    if _info_has_all(info or {}):
        expires_at = (info or {}).get("expires_at", "")
        needs_refresh = False
        if spec.refresh_threshold_days is not None:
            days = tokens_mod.days_until(expires_at)
            if days is not None and days <= spec.refresh_threshold_days:
                needs_refresh = True
        if spec.refresh_threshold_seconds is not None:
            secs = tokens_mod.seconds_until(expires_at)
            if secs is not None and secs <= spec.refresh_threshold_seconds:
                needs_refresh = True

        if needs_refresh:
            do_refresh()
            tokens = tokens_mod.load(tokens_path)
            info = (tokens.get(spec.platform_key) or {}).get(account) or info

        values = tuple((info or {}).get(f, "") for f in spec.field_names)
        return (*values, "tokens.json")

    # env fallback
    env_values = []
    have_all_env = True
    for env_name in spec.env_fallback:
        if env_name is None:
            have_all_env = False
            break
        v = (os.environ.get(env_name) or "").strip()
        if not v:
            have_all_env = False
            break
        env_values.append(v)
    if have_all_env:
        return (*env_values, "env")

    return (*("" for _ in spec.field_names), "none")
