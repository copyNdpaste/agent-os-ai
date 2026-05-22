#!/usr/bin/env python3
# version: threads_uploader_v4_clean
"""Threads 자동 업로더 (멀티 계정 + 이미지/영상 + 500자 초과 reply chain).

공통 헬퍼는 `_common/` 모듈로 분리됨. 이 파일의 Threads 전용 로직:
    - 500자 초과 시 자연 경계 분할 + i/N 접두 reply chain
    - VIDEO 컨테이너 status 폴링 (FINISHED 까지)
    - publish + permalink 조회
"""
import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request

from _common import drafts, telegram
from _common.credentials import CredentialSpec, resolve as resolve_credentials
from _common.http import HttpError, form_post, get_json

HERE = os.path.dirname(os.path.abspath(__file__))
DRAFTS_DIR = os.path.join(HERE, "drafts")
TOKENS_PATH = os.path.join(HERE, "tokens.json")
TOKEN_MANAGER_PATH = os.path.join(HERE, "token_manager.py")
THREADS_API_BASE = "https://graph.threads.net/v1.0"

THREADS_TEXT_LIMIT = 500
THREADS_CHUNK_BUDGET = 480  # "i/N " 접두 여유분
MAX_CHUNKS = 10
CHUNK_SLEEP_SEC = 1.5

POLL_MAX_TRIES = 30
POLL_INTERVAL_SEC = 5

CRED_SPEC = CredentialSpec(
    platform_key="threads",
    field_names=("access_token", "user_id"),
    env_fallback=("META_THREADS_ACCESS_TOKEN", "META_THREADS_USER_ID"),
    refresh_threshold_days=7.0,
)


# ─── Threads-specific 헬퍼 ──────────────────────────────────────────────────

def _save_threads_draft(text: str, image_url: str, video_url: str,
                        media_type: str, reply_control: str, account: str) -> str:
    fm = drafts.build_frontmatter([
        ("status", "draft"),
        ("target", "threads"),
        ("account", account),
        ("created_at", drafts.now_iso()),
        ("reply_control", reply_control),
        ("media_type", media_type),
        ("image_url", image_url),
        ("video_url", video_url),
    ])
    path = os.path.join(DRAFTS_DIR, f"threads-{account}-{drafts.now_stamp()}.md")
    return drafts.write_draft(path, fm, text)


def chunk_text(text: str, budget: int = THREADS_CHUNK_BUDGET) -> list:
    """긴 글을 (문단 → 문장 → 단어 → hard) 경계로 잘라 N 조각.
    단일 조각이면 접두 없음, N>1 이면 'i/N ' 접두."""
    text = (text or "").strip()
    if len(text) <= THREADS_TEXT_LIMIT:
        return [text]

    raw_chunks = []
    remaining = text
    while remaining:
        if len(remaining) <= budget:
            raw_chunks.append(remaining.strip())
            break
        cut = remaining.rfind("\n\n", 0, budget)
        if cut < int(budget * 0.5):
            best = -1
            for punct in [". ", "! ", "? ", "。", "！", "？", "…", "\n"]:
                p = remaining.rfind(punct, 0, budget)
                if p > best:
                    best = p + len(punct)
            cut = best if best > int(budget * 0.5) else cut
        if cut < int(budget * 0.5):
            cut = remaining.rfind(" ", 0, budget)
        if cut < int(budget * 0.5):
            cut = budget
        raw_chunks.append(remaining[:cut].strip())
        remaining = remaining[cut:].strip()

    n = len(raw_chunks)
    if n == 1:
        return raw_chunks
    if n > MAX_CHUNKS:
        raw_chunks = raw_chunks[:MAX_CHUNKS]
        raw_chunks[-1] = raw_chunks[-1].rstrip() + " (이하 생략)"
        n = MAX_CHUNKS
    return [f"{i+1}/{n} {c}" for i, c in enumerate(raw_chunks)]


def _poll_container_status(creation_id: str, access_token: str,
                           max_tries: int = POLL_MAX_TRIES,
                           interval: int = POLL_INTERVAL_SEC) -> str:
    q = urllib.parse.urlencode({
        "fields": "status,error_message",
        "access_token": access_token,
    })
    status_url = f"{THREADS_API_BASE}/{urllib.parse.quote(creation_id)}?{q}"
    last = ""
    for _ in range(max_tries):
        try:
            data = get_json(status_url, context="Threads API")
            status = (data.get("status") or "").upper()
            last = status
            if status == "FINISHED":
                return status
            if status in ("ERROR", "EXPIRED"):
                raise RuntimeError(
                    f"Threads container 처리 실패 (status={status}): {data.get('error_message', '')}"
                )
        except HttpError:
            pass
        time.sleep(interval)
    raise RuntimeError(f"Threads container 인코딩 타임아웃 (last status={last or '?'})")


def _fetch_permalink(thread_id: str, access_token: str) -> str:
    try:
        q = urllib.parse.urlencode({
            "fields": "permalink",
            "access_token": access_token,
        })
        meta = get_json(
            f"{THREADS_API_BASE}/{urllib.parse.quote(thread_id)}?{q}",
            timeout=15, context="Threads API",
        )
        return meta.get("permalink", "") or ""
    except Exception:
        return ""


def _post_single(payload: dict, user_id: str, access_token: str) -> str:
    """media container 생성 → publish → thread_id 반환."""
    create_url = f"{THREADS_API_BASE}/{urllib.parse.quote(user_id)}/threads"
    publish_url = f"{THREADS_API_BASE}/{urllib.parse.quote(user_id)}/threads_publish"
    created = form_post(create_url, payload, context="Threads API")
    creation_id = created.get("id")
    if not creation_id:
        raise RuntimeError(f"Threads create 응답에 id 없음: {created}")
    if payload.get("media_type") == "VIDEO":
        _poll_container_status(creation_id, access_token)
    published = form_post(publish_url, {
        "creation_id": creation_id,
        "access_token": access_token,
    }, context="Threads API")
    return published.get("id") or creation_id


def _real_post_thread(chunks: list, reply_control: str,
                      access_token: str, user_id: str) -> dict:
    """N개 텍스트 조각을 reply chain 으로 순차 게시."""
    thread_ids = []
    parent_id = None
    permalink = ""

    for i, chunk in enumerate(chunks):
        payload = {
            "media_type": "TEXT",
            "text": chunk,
            "access_token": access_token,
            "reply_control": reply_control,
        }
        if parent_id:
            payload["reply_to_id"] = parent_id
        thread_id = _post_single(payload, user_id, access_token)
        thread_ids.append(thread_id)
        parent_id = thread_id
        if i == 0:
            permalink = _fetch_permalink(thread_id, access_token)
        if i < len(chunks) - 1:
            time.sleep(CHUNK_SLEEP_SEC)

    return {
        "thread_id": thread_ids[0],
        "thread_ids": thread_ids,
        "chunks": len(chunks),
        "permalink": permalink,
    }


def _real_post(text: str, image_url: str, video_url: str, media_type: str,
               reply_control: str, access_token: str, user_id: str) -> dict:
    mt = (media_type or "text").lower()
    if mt == "image" and image_url:
        api_mt = "IMAGE"
    elif mt == "video" and video_url:
        api_mt = "VIDEO"
    else:
        api_mt = "TEXT"

    payload = {
        "media_type": api_mt,
        "text": text,
        "access_token": access_token,
        "reply_control": reply_control,
    }
    if api_mt == "IMAGE":
        payload["image_url"] = image_url
    elif api_mt == "VIDEO":
        payload["video_url"] = video_url

    thread_id = _post_single(payload, user_id, access_token)
    return {
        "thread_id": thread_id,
        "permalink": _fetch_permalink(thread_id, access_token),
    }


def _resolve_threads_credentials(account: str):
    return resolve_credentials(
        account,
        CRED_SPEC,
        tokens_path=TOKENS_PATH,
        token_manager_path=TOKEN_MANAGER_PATH,
    )


def main():
    ap = argparse.ArgumentParser(description="Threads 자동 업로더 (멀티 계정 + 영상)")
    ap.add_argument("--text", required=True)
    ap.add_argument("--account", default="default")
    ap.add_argument("--media-type", default="text",
                    choices=["text", "image", "video"])
    ap.add_argument("--image-url", default="")
    ap.add_argument("--video-url", default="")
    ap.add_argument("--reply-control", default="everyone",
                    choices=["everyone", "mentioned", "followers"])
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    account = (args.account or "default").lower()
    media_type = (args.media_type or "text").lower()

    if media_type == "image" and not args.image_url:
        sys.stderr.write("❌ --media-type image 면 --image-url 필요\n")
        return 2
    if media_type == "video" and not args.video_url:
        sys.stderr.write("❌ --media-type video 면 --video-url 필요\n")
        return 2

    access_token, user_id, source = _resolve_threads_credentials(account)
    use_draft = args.dry_run or (not access_token) or (not user_id)

    if use_draft:
        path = _save_threads_draft(args.text, args.image_url, args.video_url,
                                   media_type, args.reply_control, account)
        preview = drafts.preview(args.text)
        telegram.push(f"✏️ 새 Threads draft 저장됨 [{account}]\n{preview}\n📁 {path}")
        print(json.dumps({
            "status": "drafted",
            "account": account,
            "media_type": media_type,
            "path": path,
            "preview": preview,
            "token_source": source,
        }, ensure_ascii=False))
        return 0

    # 텍스트 only + 500자 초과 → reply chain
    needs_chain = (media_type == "text") and (len(args.text or "") > THREADS_TEXT_LIMIT)
    chunks = chunk_text(args.text) if needs_chain else None

    def _do_post():
        if chunks:
            return _real_post_thread(chunks, args.reply_control, access_token, user_id)
        return _real_post(args.text, args.image_url, args.video_url,
                          media_type, args.reply_control,
                          access_token, user_id)

    try:
        result = _do_post()
    except Exception as e:
        msg = str(e)
        if any(s in msg for s in ("401", "190", "expired", "Invalid")):
            from _common import tokens as tokens_mod
            tokens_mod.trigger_refresh(TOKEN_MANAGER_PATH)
            access_token, user_id, source = _resolve_threads_credentials(account)
            try:
                result = _do_post()
            except Exception as e2:
                sys.stderr.write(f"❌ Threads 게시 실패 [{account}]: {e2}\n")
                sys.stderr.write("   → python3 token_manager.py --bootstrap 으로 재발급 권장\n")
                return 1
        else:
            sys.stderr.write(f"❌ Threads 게시 실패 [{account}]: {e}\n")
            return 1

    print(json.dumps({
        "status": "posted",
        "account": account,
        "permalink": result.get("permalink", ""),
        "thread_id": result.get("thread_id", ""),
        "token_source": source,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
