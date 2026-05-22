"""_common.drafts BDD 시나리오."""
from __future__ import annotations

import os

from _common import drafts


def test_now_stamp_은_14자_숫자_타임스탬프를_반환한다():
    # Given: now_stamp 호출
    # When:  반환값 길이/형식 확인
    stamp = drafts.now_stamp()
    # Then: YYYYMMDD-HHMMSS (15자: 8+1+6) 형식
    assert len(stamp) == 15
    assert stamp[8] == "-"
    assert stamp[:8].isdigit()
    assert stamp[9:].isdigit()


def test_preview는_100자_이하는_그대로_반환한다():
    # Given: 100자 이하 텍스트
    text = "안녕하세요"
    # When: preview
    out = drafts.preview(text)
    # Then: 원문 그대로
    assert out == "안녕하세요"


def test_preview는_긴_텍스트를_말줄임표로_잘라낸다():
    # Given: 200자 텍스트
    text = "가" * 200
    # When: preview 기본 길이(100)
    out = drafts.preview(text)
    # Then: 정확히 100자 + "..."
    assert out == "가" * 100 + "..."


def test_preview는_개행을_공백으로_치환한다():
    # Given: 여러 줄 텍스트
    text = "첫째 줄\n둘째 줄\n셋째 줄"
    # When: preview
    out = drafts.preview(text)
    # Then: 개행이 공백으로 치환됨
    assert "\n" not in out
    assert "첫째 줄 둘째 줄 셋째 줄" == out


def test_build_frontmatter는_None과_빈값을_스킵한다():
    # Given: 일부 값이 None/빈문자열인 필드
    fields = [
        ("status", "draft"),
        ("account", None),
        ("media_url", ""),
        ("target", "instagram"),
    ]
    # When: frontmatter 생성
    out = drafts.build_frontmatter(fields)
    # Then: None/빈값 라인은 빠짐
    assert "status: draft" in out
    assert "target: instagram" in out
    assert "account:" not in out
    assert "media_url:" not in out
    assert out.startswith("---") and out.endswith("---")


def test_build_frontmatter는_리스트값을_같은_key로_반복_출력한다():
    # Given: media_url 이 여러 개
    fields = [
        ("status", "draft"),
        ("media_url", ["https://a.jpg", "https://b.jpg"]),
    ]
    # When: frontmatter 생성
    out = drafts.build_frontmatter(fields)
    # Then: media_url 라인이 2개
    assert out.count("media_url:") == 2
    assert "media_url: https://a.jpg" in out
    assert "media_url: https://b.jpg" in out


def test_write_draft는_frontmatter와_본문을_합쳐_저장한다(tmp_path):
    # Given: 임시 경로 + frontmatter + 본문
    target = tmp_path / "drafts" / "x-20260522-123456.md"
    fm = drafts.build_frontmatter([("status", "draft"), ("target", "x")])
    body = "오늘의 글"

    # When: write_draft 호출
    returned = drafts.write_draft(str(target), fm, body)

    # Then: 파일이 만들어지고 frontmatter + 본문 둘 다 들어가 있음
    assert returned == str(target)
    assert os.path.isfile(target)
    content = target.read_text(encoding="utf-8")
    assert "status: draft" in content
    assert "오늘의 글" in content
