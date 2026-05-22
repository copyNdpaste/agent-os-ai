"""_common.credentials BDD 시나리오."""
from __future__ import annotations

import json

from _common.credentials import CredentialSpec, resolve


INSTAGRAM_SPEC = CredentialSpec(
    platform_key="instagram",
    field_names=("access_token", "user_id"),
    env_fallback=("META_IG_ACCESS_TOKEN", "META_IG_USER_ID"),
    refresh_threshold_days=7.0,
)


def _write_tokens(path, payload):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f)


def test_resolve는_tokens_json에서_자격증명을_가져온다(tmp_path):
    # Given: tokens.json 에 jp 계정 정보
    tokens_path = tmp_path / "tokens.json"
    _write_tokens(tokens_path, {
        "instagram": {
            "jp": {
                "access_token": "AT-jp",
                "user_id": "UID-jp",
                "expires_at": "2099-01-01T00:00:00",
            }
        }
    })

    # When: resolve
    at, uid, src = resolve(
        "jp",
        INSTAGRAM_SPEC,
        tokens_path=str(tokens_path),
        token_manager_path=str(tmp_path / "no-tm.py"),
    )

    # Then: tokens.json 출처로 값 반환
    assert at == "AT-jp"
    assert uid == "UID-jp"
    assert src == "tokens.json"


def test_resolve는_tokens_없을_때_env로_fallback한다(tmp_path, monkeypatch):
    # Given: tokens.json 없음 + env 변수 있음
    monkeypatch.setenv("META_IG_ACCESS_TOKEN", "ENV-AT")
    monkeypatch.setenv("META_IG_USER_ID", "ENV-UID")

    # When: resolve
    at, uid, src = resolve(
        "jp",
        INSTAGRAM_SPEC,
        tokens_path=str(tmp_path / "missing.json"),
        token_manager_path=str(tmp_path / "no-tm.py"),
    )

    # Then: env 출처
    assert at == "ENV-AT"
    assert uid == "ENV-UID"
    assert src == "env"


def test_resolve는_둘_다_없을_때_none을_반환한다(tmp_path, monkeypatch):
    # Given: tokens.json 없음 + env 변수 없음
    monkeypatch.delenv("META_IG_ACCESS_TOKEN", raising=False)
    monkeypatch.delenv("META_IG_USER_ID", raising=False)

    # When: resolve
    at, uid, src = resolve(
        "jp",
        INSTAGRAM_SPEC,
        tokens_path=str(tmp_path / "missing.json"),
        token_manager_path=str(tmp_path / "no-tm.py"),
    )

    # Then: 빈 값 + "none" 출처
    assert at == ""
    assert uid == ""
    assert src == "none"


def test_resolve는_만료_임박시_refresh_콜백을_호출한다(tmp_path):
    # Given: 만료까지 1일 남은 토큰 (threshold=7일)
    tokens_path = tmp_path / "tokens.json"
    _write_tokens(tokens_path, {
        "instagram": {
            "jp": {
                "access_token": "OLD-AT",
                "user_id": "UID",
                "expires_at": "2026-05-23T00:00:00",  # 약 1일 후 (현재 2026-05-22 기준)
            }
        }
    })

    refresh_called = {"count": 0}

    def fake_refresh():
        refresh_called["count"] += 1
        # refresh 후 토큰 갱신된 것처럼 파일 다시 씀
        _write_tokens(tokens_path, {
            "instagram": {
                "jp": {
                    "access_token": "NEW-AT",
                    "user_id": "UID",
                    "expires_at": "2099-01-01T00:00:00",
                }
            }
        })
        return True

    # When: resolve (만료 임박 → refresh 트리거)
    at, _, src = resolve(
        "jp",
        INSTAGRAM_SPEC,
        tokens_path=str(tokens_path),
        token_manager_path=str(tmp_path / "no-tm.py"),
        trigger_refresh=fake_refresh,
    )

    # Then: refresh 1회 호출됨 + 갱신된 토큰 사용
    assert refresh_called["count"] == 1
    assert at == "NEW-AT"
    assert src == "tokens.json"
