"""x_uploader 내부 헬퍼 BDD 시나리오 (네트워크 호출 없음)."""
from __future__ import annotations

import x_uploader as xu


def test_guess_content_type은_mp4_URL을_video로_인식한다():
    # Given: .mp4 URL
    url = "https://cdn.example.com/clip.mp4"
    # When: media_type 미지정 (빈 문자열)
    ct, fn = xu._guess_content_type(url, "")
    # Then: video/mp4 + clip.mp4 파일명
    assert ct == "video/mp4"
    assert fn == "clip.mp4"


def test_guess_content_type은_쿼리스트링_뒤_확장자를_무시한다():
    # Given: 쿼리스트링이 붙은 URL
    url = "https://cdn/photo.png?token=abc"
    # When
    ct, fn = xu._guess_content_type(url, "image")
    # Then: png 인식
    assert ct == "image/png"
    assert fn == "img.png"


def test_guess_content_type은_확장자_없으면_jpeg로_기본값():
    # Given: 확장자 없는 URL
    url = "https://cdn/photo"
    # When
    ct, fn = xu._guess_content_type(url, "image")
    # Then: jpeg 기본값
    assert ct == "image/jpeg"
    assert fn == "img.jpg"


def test_utc_iso_now는_Z로_끝나는_ISO_문자열을_반환한다():
    # Given/When
    out = xu._utc_iso_now()
    # Then: ISO 형식 + Z suffix
    assert out.endswith("Z")
    assert "T" in out
    # 19자 (YYYY-MM-DDTHH:MM:SS) + Z = 20
    assert len(out) == 20


def test_utc_iso_in은_지정한_초만큼_미래_시각을_반환한다():
    # Given: 7200초 = 2시간
    out = xu._utc_iso_in(7200)
    now = xu._utc_iso_now()
    # Then: 미래 시각 (lexicographic 비교로 충분 — ISO 형식)
    assert out > now
