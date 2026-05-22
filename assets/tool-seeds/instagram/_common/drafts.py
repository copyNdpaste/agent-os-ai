"""Draft 저장 + 미리보기 헬퍼.

각 uploader 의 _save_draft 시그니처가 달라도 frontmatter 빌더만 공통화하면
플랫폼별 키 차이를 흡수할 수 있다.
"""
from __future__ import annotations

import os
import time
from typing import Iterable


def ensure_dir(path: str) -> None:
    """디렉터리가 없으면 생성. 이미 있으면 무시."""
    os.makedirs(path, exist_ok=True)


def now_stamp() -> str:
    """파일명용 타임스탬프 (YYYYMMDD-HHMMSS)."""
    return time.strftime("%Y%m%d-%H%M%S")


def now_iso() -> str:
    """ISO 시각 (created_at 등 frontmatter 용)."""
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def preview(text: str, n: int = 100) -> str:
    """텔레그램/로그용 한 줄 미리보기."""
    t = (text or "").strip().replace("\n", " ")
    return t if len(t) <= n else t[:n] + "..."


def build_frontmatter(fields: Iterable[tuple]) -> str:
    """YAML frontmatter 블록을 생성.

    `fields` 는 (key, value) 튜플 시퀀스.
    value 가 list/tuple 이면 같은 key 를 반복해 출력 (예: media_url).
    None / 빈 문자열은 스킵.
    """
    lines = ["---"]
    for key, value in fields:
        if value is None or value == "":
            continue
        if isinstance(value, (list, tuple)):
            for item in value:
                if item is None or item == "":
                    continue
                lines.append(f"{key}: {item}")
        else:
            lines.append(f"{key}: {value}")
    lines.append("---")
    return "\n".join(lines)


def write_draft(path: str, frontmatter: str, body: str) -> str:
    """frontmatter + 본문을 파일로 저장하고 경로를 반환."""
    ensure_dir(os.path.dirname(path))
    payload = frontmatter + "\n\n" + (body or "") + "\n"
    with open(path, "w", encoding="utf-8") as f:
        f.write(payload)
    return path
