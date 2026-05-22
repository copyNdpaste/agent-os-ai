"""urllib 기반 HTTP 헬퍼 — 외부 라이브러리 의존 없음.

세 종류의 호출 패턴을 통일:
    - form_post: form-urlencoded POST → JSON 응답
    - get_json:  GET → JSON 응답
    - json_body_post: JSON body POST + Authorization 헤더
    - multipart_post: multipart/form-data POST + 파일 업로드
    - download: 단순 GET 으로 bytes
"""
from __future__ import annotations

import json
import secrets
import urllib.error
import urllib.parse
import urllib.request


class HttpError(RuntimeError):
    """HTTP/네트워크/JSON 파싱 실패를 통합한 예외."""


def _read_error_body(e: urllib.error.HTTPError) -> str:
    try:
        return e.read().decode("utf-8", errors="replace")
    except Exception:
        return ""


def _parse_json(raw: str, *, context: str) -> dict:
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        raise HttpError(f"{context} 응답 JSON 파싱 실패: {raw[:200]}")


def form_post(url: str, payload: dict, *, timeout: int = 30,
              context: str = "API") -> dict:
    """form-urlencoded POST → JSON dict."""
    data = urllib.parse.urlencode(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        raise HttpError(f"{context} HTTP {e.code}: {_read_error_body(e)[:400]}")
    except urllib.error.URLError as e:
        raise HttpError(f"{context} 네트워크 실패: {e.reason}")
    return _parse_json(raw, context=context)


def get_json(url: str, *, timeout: int = 30, context: str = "API") -> dict:
    """GET → JSON dict."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            raw = r.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        raise HttpError(f"{context} HTTP {e.code}: {_read_error_body(e)[:400]}")
    except urllib.error.URLError as e:
        raise HttpError(f"{context} 네트워크 실패: {e.reason}")
    return _parse_json(raw, context=context)


def json_body_post(url: str, *, body: dict, bearer: str,
                   method: str = "POST", timeout: int = 60,
                   context: str = "API") -> dict:
    """JSON body POST + Bearer 인증."""
    raw_bytes = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=raw_bytes, method=method)
    req.add_header("Authorization", f"Bearer {bearer}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        raise HttpError(f"{context} HTTP {e.code}: {_read_error_body(e)[:400]}")
    except urllib.error.URLError as e:
        raise HttpError(f"{context} 네트워크 실패: {e.reason}")
    return _parse_json(raw, context=context)


def download(url: str, *, timeout: int = 60) -> bytes:
    """단순 GET → raw bytes."""
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def multipart_post(url: str, *, bearer: str, fields: dict,
                   file_field: str = None, file_bytes: bytes = None,
                   filename: str = "file.bin",
                   content_type: str = "application/octet-stream",
                   timeout: int = 120, context: str = "upload") -> dict:
    """간단한 multipart/form-data POST. urllib 만 사용."""
    boundary = "----xupload" + secrets.token_hex(8)
    parts: list[bytes] = []
    for k, v in fields.items():
        parts.append(f"--{boundary}".encode())
        parts.append(f'Content-Disposition: form-data; name="{k}"'.encode())
        parts.append(b"")
        parts.append(str(v).encode("utf-8"))
    if file_field and file_bytes is not None:
        parts.append(f"--{boundary}".encode())
        parts.append(
            f'Content-Disposition: form-data; name="{file_field}"; filename="{filename}"'.encode()
        )
        parts.append(f"Content-Type: {content_type}".encode())
        parts.append(b"")
        parts.append(file_bytes)
    parts.append(f"--{boundary}--".encode())
    parts.append(b"")
    body = b"\r\n".join(parts)

    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Authorization", f"Bearer {bearer}")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        raise HttpError(f"{context} HTTP {e.code}: {_read_error_body(e)[:400]}")
    except urllib.error.URLError as e:
        raise HttpError(f"{context} 네트워크 실패: {e.reason}")
    return _parse_json(raw, context=context)
