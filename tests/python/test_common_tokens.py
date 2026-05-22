"""_common.tokens BDD 시나리오."""
from __future__ import annotations

import json
import os

from _common import tokens as tokens_mod


def test_load는_파일_없을_때_빈_dict를_반환한다(tmp_path):
    # Given: 존재하지 않는 경로
    missing = tmp_path / "does-not-exist.json"
    # When: load
    out = tokens_mod.load(str(missing))
    # Then: 빈 dict, 예외 없음
    assert out == {}


def test_load는_손상된_JSON에서도_빈_dict를_반환한다(tmp_path):
    # Given: 손상된 JSON 파일
    bad = tmp_path / "broken.json"
    bad.write_text("{not valid json", encoding="utf-8")
    # When: load
    out = tokens_mod.load(str(bad))
    # Then: 빈 dict (조용한 실패)
    assert out == {}


def test_save는_원자적으로_저장하고_권한을_600으로_설정한다(tmp_path):
    # Given: 저장할 토큰 dict
    target = tmp_path / "deep" / "tokens.json"
    payload = {"instagram": {"jp": {"access_token": "abc"}}}

    # When: save
    tokens_mod.save(str(target), payload)

    # Then: 파일 존재 + 내용 일치 + 권한 0o600 (POSIX 한정)
    assert target.is_file()
    loaded = json.loads(target.read_text(encoding="utf-8"))
    assert loaded == payload
    if os.name == "posix":
        mode = os.stat(target).st_mode & 0o777
        assert mode == 0o600


def test_days_until은_과거_시각에_대해_음수를_반환한다():
    # Given: 1년 전 ISO 시각
    past = "2025-01-01T00:00:00"
    # When: days_until
    out = tokens_mod.days_until(past)
    # Then: 음수 (이미 만료)
    assert out is not None
    assert out < 0


def test_days_until은_파싱_실패시_None을_반환한다():
    # Given: 빈 문자열, 잘못된 형식
    # When/Then: 둘 다 None
    assert tokens_mod.days_until("") is None
    assert tokens_mod.days_until("not a date") is None


def test_trigger_refresh는_token_manager_없을_때_False를_반환한다(tmp_path):
    # Given: 존재하지 않는 token_manager 경로
    missing = tmp_path / "no_manager.py"
    # When: trigger_refresh
    out = tokens_mod.trigger_refresh(str(missing))
    # Then: False, 예외 없음
    assert out is False
