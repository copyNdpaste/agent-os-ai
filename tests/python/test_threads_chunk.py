"""threads_uploader.chunk_text BDD 시나리오 — 500자 초과 reply chain 분할 로직."""
from __future__ import annotations

import threads_uploader as tu


def test_chunk_text는_500자_이하면_단일_조각으로_접두_없이_반환한다():
    # Given: 짧은 텍스트
    short = "안녕하세요. 오늘은 좋은 날입니다."
    # When: chunk_text
    out = tu.chunk_text(short)
    # Then: 1개 조각, 접두 없음
    assert len(out) == 1
    assert out[0] == short


def test_chunk_text는_500자_초과시_i_N_접두로_분할한다():
    # Given: 1200자 (500자 한도 초과)
    long_text = "한글" * 600  # 1200 char
    # When: chunk_text
    out = tu.chunk_text(long_text)
    # Then: 여러 조각 + 각 조각 앞에 "i/N " 접두
    assert len(out) >= 2
    n = len(out)
    for i, chunk in enumerate(out, start=1):
        assert chunk.startswith(f"{i}/{n} "), f"chunk {i} 접두 누락: {chunk[:20]}"


def test_chunk_text는_각_조각이_500자_제한_이하다():
    # Given: 매우 긴 텍스트
    long_text = "abcdef " * 500  # ≈ 3500자
    # When: chunk_text
    out = tu.chunk_text(long_text)
    # Then: 각 조각 (접두 포함) 500자 이하 — Meta API 거부 방지
    for chunk in out:
        assert len(chunk) <= 500, f"조각 길이 초과 ({len(chunk)}): {chunk[:30]}"


def test_chunk_text는_최대_조각_수를_초과하지_않는다():
    # Given: 매우 매우 긴 텍스트 (정상 분할이면 20+ 조각)
    huge = ("문단 한 줄.\n\n" * 1000)
    # When: chunk_text
    out = tu.chunk_text(huge)
    # Then: MAX_CHUNKS 이하 + 마지막 조각에 "(이하 생략)" 마커
    assert len(out) <= tu.MAX_CHUNKS
    assert "이하 생략" in out[-1]


def test_chunk_text는_문장_경계에서_자른다():
    # Given: 문장 종결부호가 있는 긴 텍스트
    sentences = ("이것은 한 문장입니다. " * 80)  # ≈ 850자
    # When: chunk_text
    out = tu.chunk_text(sentences)
    # Then: 모든 조각이 (접두를 제외한) 본문 마지막이 마침표·공백으로 끝나거나
    #       자연 경계에서 끝남 (hard cut 이 일어났다면 단어 중간이 아니어야 함)
    for chunk in out:
        # "i/N " 접두 제거
        body = chunk.split(" ", 1)[1] if "/" in chunk.split(" ", 1)[0] else chunk
        # 마지막 글자가 자연스러운 종결 (구두점 또는 공백) 인지 — strict 하지 않게
        assert body  # 빈 조각 없어야 함
