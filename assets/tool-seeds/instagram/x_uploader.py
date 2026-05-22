#!/usr/bin/env python3
# version: x_uploader_v2_clean
"""X (Twitter) 자동 업로더 — OAuth 2.0 + chunked video upload.

공통 헬퍼는 `_common/` 모듈로 분리됨. X-specific 부분만 이 파일에 남김:
    - OAuth 2.0 inline refresh (token_manager 외 fallback)
    - 미디어 업로드 v1.1 (이미지 simple / 영상 INIT→APPEND→FINALIZE→STATUS)
    - 트윗 게시 v2
    - account 별 env 키 (X_OAUTH_TOKEN_{ACCT})
"""
import argparse
import base64
import datetime as dt
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from _common import drafts, telegram
from _common import tokens as tokens_mod
from _common.http import (
    HttpError, download, json_body_post, multipart_post,
)

HERE = os.path.dirname(os.path.abspath(__file__))
DRAFTS_DIR = os.path.join(HERE, "drafts")
TOKENS_PATH = os.path.join(HERE, "tokens.json")
TOKEN_MANAGER_PATH = os.path.join(HERE, "token_manager.py")

API_TWEETS = "https://api.x.com/2/tweets"
API_OAUTH_TOKEN = "https://api.x.com/2/oauth2/token"
UPLOAD_V1 = "https://upload.twitter.com/1.1/media/upload.json"

# X access token 은 2시간 — 30분 이하면 자동 갱신.
REFRESH_THRESHOLD_SECONDS = 30 * 60
VIDEO_CHUNK_BYTES = 5 * 1024 * 1024
VIDEO_STATUS_MAX_TRIES = 30
TWEET_TEXT_LIMIT = 280


# ─── X-specific draft ─────────────────────────────────────────────────────

def _save_x_draft(text: str, media_urls, media_type: str,
                  reply_to: str, account: str) -> str:
    fm = drafts.build_frontmatter([
        ("status", "draft"),
        ("target", "x"),
        ("account", account),
        ("created_at", drafts.now_iso()),
        ("media_type", media_type if media_urls else ""),
        ("media_url", list(media_urls or [])),
        ("reply_to", reply_to),
    ])
    path = os.path.join(DRAFTS_DIR, f"x-{drafts.now_stamp()}-{account}.md")
    return drafts.write_draft(path, fm, text)


# ─── OAuth 2.0 inline refresh ──────────────────────────────────────────────

def _x_refresh_inline(refresh_token: str, client_id: str,
                      client_secret: str) -> dict:
    """token_manager 외 fallback — 우리가 직접 갱신 시도."""
    data = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": client_id,
    }).encode("utf-8")
    req = urllib.request.Request(API_OAUTH_TOKEN, data=data, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    if client_secret:
        basic = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
        req.add_header("Authorization", f"Basic {basic}")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        raise RuntimeError(f"refresh HTTP {e.code}: {body[:300]}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"refresh 네트워크 실패: {e.reason}")


def _utc_iso_in(seconds: int) -> str:
    when = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None, microsecond=0)
    return (when + dt.timedelta(seconds=seconds)).isoformat() + "Z"


def _utc_iso_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(tzinfo=None, microsecond=0).isoformat() + "Z"


def _persist_refreshed_token(account: str, access_token: str,
                             refresh_token: str, expires_in: int) -> None:
    """X tokens.json 에 갱신된 토큰을 기록 (best-effort)."""
    try:
        tokens = tokens_mod.load(TOKENS_PATH)
        tokens.setdefault("x", {}).setdefault(account, {}).update({
            "access_token": access_token,
            "refresh_token": refresh_token,
            "expires_at": _utc_iso_in(expires_in),
            "refreshed_at": _utc_iso_now(),
        })
        tokens_mod.save(TOKENS_PATH, tokens)
    except Exception:
        pass


def _resolve_credentials(account: str):
    """X 자격증명 해석.

    1) tokens.json[x][account]
       만료 임박 → token_manager --refresh → 그래도 부족하면 inline refresh
    2) env: X_OAUTH_TOKEN_{ACCT} (+ X_OAUTH_REFRESH_TOKEN_{ACCT})
    반환: (access_token, refresh_token, source)
    """
    tokens = tokens_mod.load(TOKENS_PATH)
    info = (tokens.get("x") or {}).get(account)

    if info and info.get("access_token"):
        secs = tokens_mod.seconds_until(info.get("expires_at", ""))
        if secs is not None and secs <= REFRESH_THRESHOLD_SECONDS:
            tokens_mod.trigger_refresh(TOKEN_MANAGER_PATH)
            tokens = tokens_mod.load(TOKENS_PATH)
            info = (tokens.get("x") or {}).get(account) or info
            secs2 = tokens_mod.seconds_until(info.get("expires_at", ""))
            if secs2 is None or secs2 <= 60:
                rt = info.get("refresh_token") or ""
                cid = (os.environ.get("X_CLIENT_ID") or "").strip()
                csec = (os.environ.get("X_CLIENT_SECRET") or "").strip()
                if rt and cid:
                    try:
                        resp = _x_refresh_inline(rt, cid, csec)
                        info = {
                            **info,
                            "access_token": resp.get("access_token") or info.get("access_token"),
                            "refresh_token": resp.get("refresh_token") or rt,
                        }
                        _persist_refreshed_token(
                            account,
                            info["access_token"],
                            info["refresh_token"],
                            int(resp.get("expires_in") or 7200),
                        )
                    except Exception:
                        pass
        return info.get("access_token", ""), info.get("refresh_token", ""), "tokens.json"

    env_at = (os.environ.get(f"X_OAUTH_TOKEN_{account.upper()}") or "").strip()
    env_rt = (os.environ.get(f"X_OAUTH_REFRESH_TOKEN_{account.upper()}") or "").strip()
    if env_at:
        return env_at, env_rt, "env"
    return "", "", "none"


# ─── 미디어 업로드 (v1.1) ──────────────────────────────────────────────────

def _guess_content_type(url: str, media_type: str) -> tuple:
    lower = url.lower().split("?", 1)[0]
    if media_type == "video" or lower.endswith(".mp4"):
        return ("video/mp4", "clip.mp4")
    if lower.endswith(".png"):
        return ("image/png", "img.png")
    if lower.endswith(".gif"):
        return ("image/gif", "img.gif")
    if lower.endswith(".webp"):
        return ("image/webp", "img.webp")
    return ("image/jpeg", "img.jpg")


def _upload_image(media_bytes: bytes, content_type: str, filename: str,
                  bearer: str) -> str:
    resp = multipart_post(
        UPLOAD_V1, bearer=bearer, fields={},
        file_field="media", file_bytes=media_bytes,
        filename=filename, content_type=content_type,
    )
    mid = resp.get("media_id_string") or str(resp.get("media_id") or "")
    if not mid:
        raise RuntimeError(f"image upload 응답에 media_id 없음: {resp}")
    return mid


def _video_status_poll(media_id: str, bearer: str, initial_state: dict) -> None:
    pi = initial_state
    state = pi.get("state")
    check_after = int(pi.get("check_after_secs") or 5)
    tries = 0
    while state in ("pending", "in_progress") and tries < VIDEO_STATUS_MAX_TRIES:
        time.sleep(min(check_after, 10))
        status_url = f"{UPLOAD_V1}?command=STATUS&media_id={urllib.parse.quote(media_id)}"
        req = urllib.request.Request(status_url)
        req.add_header("Authorization", f"Bearer {bearer}")
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                resp = json.loads(r.read().decode("utf-8", errors="replace"))
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"STATUS HTTP {e.code}")
        pi = resp.get("processing_info") or {}
        state = pi.get("state")
        check_after = int(pi.get("check_after_secs") or 5)
        tries += 1
    if state == "failed":
        raise RuntimeError(f"video 처리 실패: {pi.get('error', pi)}")


def _upload_video_chunked(media_bytes: bytes, bearer: str,
                          content_type: str = "video/mp4") -> str:
    total = len(media_bytes)

    init = multipart_post(
        UPLOAD_V1, bearer=bearer,
        fields={
            "command": "INIT",
            "total_bytes": total,
            "media_type": content_type,
            "media_category": "tweet_video",
        },
    )
    mid = init.get("media_id_string") or str(init.get("media_id") or "")
    if not mid:
        raise RuntimeError(f"video INIT 응답에 media_id 없음: {init}")

    seg = 0
    for off in range(0, total, VIDEO_CHUNK_BYTES):
        multipart_post(
            UPLOAD_V1, bearer=bearer,
            fields={
                "command": "APPEND",
                "media_id": mid,
                "segment_index": seg,
            },
            file_field="media",
            file_bytes=media_bytes[off: off + VIDEO_CHUNK_BYTES],
            filename="chunk.bin",
            content_type="application/octet-stream",
        )
        seg += 1

    fin = multipart_post(
        UPLOAD_V1, bearer=bearer,
        fields={"command": "FINALIZE", "media_id": mid},
    )
    _video_status_poll(mid, bearer, fin.get("processing_info") or {})
    return mid


def _ingest_media(media_urls, media_type: str, bearer: str) -> list:
    out = []
    for u in media_urls:
        b = download(u)
        ct, fn = _guess_content_type(u, media_type)
        if media_type == "video":
            out.append(_upload_video_chunked(b, bearer, content_type=ct))
        else:
            out.append(_upload_image(b, ct, fn, bearer))
    return out


# ─── 트윗 게시 ──────────────────────────────────────────────────────────────

def _post_tweet(text: str, media_ids: list, reply_to: str, bearer: str) -> dict:
    body = {"text": text}
    if media_ids:
        body["media"] = {"media_ids": media_ids}
    if reply_to:
        body["reply"] = {"in_reply_to_tweet_id": str(reply_to)}
    return json_body_post(API_TWEETS, body=body, bearer=bearer, context="X API")


def _real_post(text: str, media_urls, media_type: str, reply_to: str,
               access_token: str) -> dict:
    media_ids = []
    if media_urls:
        media_ids = _ingest_media(media_urls, media_type, access_token)
    resp = _post_tweet(text, media_ids, reply_to, access_token)
    data = resp.get("data") or {}
    tweet_id = str(data.get("id") or "")
    if not tweet_id:
        raise RuntimeError(f"tweet 응답에 id 없음: {resp}")
    return {
        "tweet_id": tweet_id,
        "permalink": f"https://x.com/i/web/status/{tweet_id}",
    }


# ─── main ───────────────────────────────────────────────────────────────────

def _retry_with_refresh(account: str, access_token: str, refresh_token: str,
                        post_fn) -> tuple:
    """401/expired 류 에러 대응: inline refresh → token_manager fallback → 재시도.

    성공 시 (result, new_source) 반환, 실패 시 (None, None).
    """
    cid = (os.environ.get("X_CLIENT_ID") or "").strip()
    csec = (os.environ.get("X_CLIENT_SECRET") or "").strip()
    refreshed = False
    if refresh_token and cid:
        try:
            resp = _x_refresh_inline(refresh_token, cid, csec)
            access_token = resp.get("access_token") or access_token
            _persist_refreshed_token(
                account,
                access_token,
                resp.get("refresh_token") or refresh_token,
                int(resp.get("expires_in") or 7200),
            )
            refreshed = True
        except Exception:
            pass
    if not refreshed:
        tokens_mod.trigger_refresh(TOKEN_MANAGER_PATH)
        access_token, refresh_token, _ = _resolve_credentials(account)
        refreshed = bool(access_token)
    if not refreshed:
        return None, None
    try:
        return post_fn(access_token), "tokens.json"
    except Exception:
        return None, None


def main():
    ap = argparse.ArgumentParser(description="X (Twitter) 자동 업로더 (멀티 계정)")
    ap.add_argument("--text", required=True, help="트윗 본문 (≤ 280자)")
    ap.add_argument("--account", default="default")
    ap.add_argument("--media-url", action="append", default=[])
    ap.add_argument("--media-type", choices=["image", "video"], default=None)
    ap.add_argument("--reply-to", default="")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    account = (args.account or "default").lower()
    media_urls = [u for u in (args.media_url or []) if u]
    media_type = (args.media_type or "").lower()

    if media_urls and not media_type:
        sys.stderr.write("❌ --media-url 이 있으면 --media-type image|video 필수\n")
        return 2

    if len(args.text or "") > TWEET_TEXT_LIMIT:
        sys.stderr.write(
            f"⚠️  본문이 {TWEET_TEXT_LIMIT}자 초과 ({len(args.text)}자) — Free tier 거부 가능\n"
        )

    draft_env = (os.environ.get("DRAFT_MODE") or "").strip().lower() in ("1", "true", "yes")
    access_token, refresh_token, source = _resolve_credentials(account)
    use_draft = args.dry_run or draft_env or (not access_token)

    if use_draft:
        path = _save_x_draft(args.text, media_urls, media_type or "text",
                             args.reply_to, account)
        preview = drafts.preview(args.text)
        telegram.push(f"✏️ 새 X draft 저장됨 [{account}]\n{preview}\n📁 {path}")
        print(json.dumps({
            "status": "drafted",
            "account": account,
            "path": path,
            "preview": preview,
            "token_source": source,
        }, ensure_ascii=False))
        return 0

    def _post(at):
        return _real_post(args.text, media_urls, media_type, args.reply_to, at)

    try:
        result = _post(access_token)
    except Exception as e:
        msg = str(e)
        if "401" in msg or "expired" in msg.lower() or "invalid_token" in msg.lower():
            result, new_source = _retry_with_refresh(
                account, access_token, refresh_token, _post,
            )
            if result is None:
                sys.stderr.write(f"❌ X 게시 실패 [{account}] (refresh 불가): {e}\n")
                sys.stderr.write("   → X Developer Portal 에서 PKCE flow 로 재발급 권장\n")
                return 1
            source = new_source or source
        else:
            sys.stderr.write(f"❌ X 게시 실패 [{account}]: {e}\n")
            return 1

    print(json.dumps({
        "status": "posted",
        "account": account,
        "permalink": result.get("permalink", ""),
        "tweet_id": result.get("tweet_id", ""),
        "token_source": source,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
