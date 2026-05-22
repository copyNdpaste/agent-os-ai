#!/usr/bin/env python3
# version: instagram_uploader_v4_clean
"""Instagram 자동 업로더 (멀티 계정 + IMAGE/REELS/CAROUSEL).

공통 헬퍼는 `_common/` 모듈로 분리됨. 이 파일은 Instagram-only 흐름만 담음:
    - 미디어 컨테이너 생성/폴링
    - CAROUSEL/REELS/IMAGE 분기
    - publish + permalink 조회
    - CLI 진입점

사용법은 v3 와 동일 (호환 유지).
"""
import argparse
import json
import os
import sys
import urllib.parse
import urllib.request

from _common import drafts, telegram
from _common.credentials import CredentialSpec, resolve as resolve_credentials
from _common.http import HttpError, form_post, get_json

HERE = os.path.dirname(os.path.abspath(__file__))
DRAFTS_DIR = os.path.join(HERE, "drafts")
TOKENS_PATH = os.path.join(HERE, "tokens.json")
TOKEN_MANAGER_PATH = os.path.join(HERE, "token_manager.py")
IG_API_BASE = "https://graph.facebook.com/v18.0"

POLL_MAX_TRIES = 30
POLL_INTERVAL_SEC = 5

CRED_SPEC = CredentialSpec(
    platform_key="instagram",
    field_names=("access_token", "user_id"),
    env_fallback=("META_IG_ACCESS_TOKEN", "META_IG_USER_ID"),
    refresh_threshold_days=7.0,
)


# ─── Instagram-specific 헬퍼 ────────────────────────────────────────────────

def _save_ig_draft(caption: str, media_urls, carousel_types,
                   media_type: str, account: str) -> str:
    fm = drafts.build_frontmatter([
        ("status", "draft"),
        ("target", "instagram"),
        ("account", account),
        ("created_at", drafts.now_iso()),
        ("media_type", media_type),
        ("media_url", list(media_urls or [])),
        ("carousel_types", ",".join(carousel_types) if carousel_types else ""),
    ])
    path = os.path.join(DRAFTS_DIR, f"instagram-{account}-{drafts.now_stamp()}.md")
    return drafts.write_draft(path, fm, caption)


def _poll_container_status(container_id: str, access_token: str,
                           max_tries: int = POLL_MAX_TRIES,
                           interval: int = POLL_INTERVAL_SEC) -> str:
    """REELS/VIDEO 컨테이너가 FINISHED 될 때까지 폴링."""
    import time
    q = urllib.parse.urlencode({
        "fields": "status_code,status",
        "access_token": access_token,
    })
    status_url = f"{IG_API_BASE}/{urllib.parse.quote(container_id)}?{q}"
    last = ""
    for _ in range(max_tries):
        try:
            data = get_json(status_url, context="IG API")
            sc = (data.get("status_code") or "").upper()
            last = sc
            if sc == "FINISHED":
                return sc
            if sc in ("ERROR", "EXPIRED"):
                raise RuntimeError(
                    f"IG container 처리 실패 (status_code={sc}): {data.get('status', '')}"
                )
        except HttpError:
            pass
        time.sleep(interval)
    raise RuntimeError(f"IG container 인코딩 타임아웃 (last={last or '?'})")


def _create_container(ig_user_id: str, payload: dict) -> str:
    create_url = f"{IG_API_BASE}/{urllib.parse.quote(ig_user_id)}/media"
    created = form_post(create_url, payload, context="IG API")
    cid = created.get("id")
    if not cid:
        raise RuntimeError(f"IG create 응답에 id 없음: {created}")
    return cid


def _publish(ig_user_id: str, creation_id: str, access_token: str) -> dict:
    publish_url = f"{IG_API_BASE}/{urllib.parse.quote(ig_user_id)}/media_publish"
    return form_post(publish_url, {
        "creation_id": creation_id,
        "access_token": access_token,
    }, context="IG API")


def _fetch_permalink(media_id: str, access_token: str) -> str:
    """best-effort permalink 조회 — 실패해도 빈 문자열."""
    try:
        q = urllib.parse.urlencode({
            "fields": "permalink",
            "access_token": access_token,
        })
        meta = get_json(
            f"{IG_API_BASE}/{urllib.parse.quote(media_id)}?{q}",
            timeout=15, context="IG API",
        )
        return meta.get("permalink", "") or ""
    except Exception:
        return ""


def _real_post(caption: str, media_urls, carousel_types, media_type: str,
               access_token: str, ig_user_id: str) -> dict:
    mt = (media_type or "IMAGE").upper()

    if mt == "CAROUSEL":
        if not media_urls or len(media_urls) < 2:
            raise RuntimeError("CAROUSEL 은 미디어 2개 이상 필요")
        if len(media_urls) > 10:
            raise RuntimeError("CAROUSEL 은 최대 10개")
        types = [t.strip().lower() for t in (carousel_types or [])]
        while len(types) < len(media_urls):
            types.append("image")

        child_ids = []
        for url, t in zip(media_urls, types):
            payload = {
                "is_carousel_item": "true",
                "access_token": access_token,
            }
            if t == "video":
                payload["media_type"] = "VIDEO"
                payload["video_url"] = url
            else:
                payload["image_url"] = url
            cid = _create_container(ig_user_id, payload)
            if t == "video":
                _poll_container_status(cid, access_token)
            child_ids.append(cid)

        parent_payload = {
            "media_type": "CAROUSEL",
            "children": ",".join(child_ids),
            "caption": caption,
            "access_token": access_token,
        }
        publish_creation_id = _create_container(ig_user_id, parent_payload)

    elif mt == "REELS":
        if not media_urls:
            raise RuntimeError("REELS 는 영상 URL 1개 필요")
        creation_id = _create_container(ig_user_id, {
            "media_type": "REELS",
            "video_url": media_urls[0],
            "caption": caption,
            "access_token": access_token,
        })
        _poll_container_status(creation_id, access_token)
        publish_creation_id = creation_id

    else:  # IMAGE
        if not media_urls:
            raise RuntimeError("IMAGE 는 이미지 URL 1개 필요")
        publish_creation_id = _create_container(ig_user_id, {
            "image_url": media_urls[0],
            "caption": caption,
            "access_token": access_token,
        })

    published = _publish(ig_user_id, publish_creation_id, access_token)
    media_id = published.get("id") or publish_creation_id
    return {
        "media_id": media_id,
        "permalink": _fetch_permalink(media_id, access_token),
    }


def _resolve_ig_credentials(account: str):
    return resolve_credentials(
        account,
        CRED_SPEC,
        tokens_path=TOKENS_PATH,
        token_manager_path=TOKEN_MANAGER_PATH,
    )


def main():
    ap = argparse.ArgumentParser(description="Instagram 자동 업로더 (멀티 계정 + IMAGE/REELS/CAROUSEL)")
    ap.add_argument("--caption", required=True)
    ap.add_argument("--media-url", action="append", default=[])
    ap.add_argument("--image-url", default="", help="(legacy) --media-url 와 동등")
    ap.add_argument("--carousel-types", default="")
    ap.add_argument("--account", default="default")
    ap.add_argument("--media-type", default="IMAGE",
                    choices=["IMAGE", "REELS", "CAROUSEL"])
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    account = (args.account or "default").lower()
    media_type = (args.media_type or "IMAGE").upper()

    media_urls = list(args.media_url or [])
    if args.image_url and args.image_url not in media_urls:
        media_urls.insert(0, args.image_url)

    carousel_types = []
    if args.carousel_types:
        carousel_types = [t.strip() for t in args.carousel_types.split(",") if t.strip()]

    if not media_urls:
        sys.stderr.write("❌ --media-url (또는 --image-url) 최소 1개 필요\n")
        return 2
    if media_type == "CAROUSEL" and len(media_urls) < 2:
        sys.stderr.write("❌ CAROUSEL 은 --media-url 2개 이상\n")
        return 2

    access_token, ig_user_id, source = _resolve_ig_credentials(account)
    use_draft = args.dry_run or (not access_token) or (not ig_user_id)

    if use_draft:
        path = _save_ig_draft(args.caption, media_urls, carousel_types, media_type, account)
        preview = drafts.preview(args.caption)
        telegram.push(f"✏️ 새 Instagram draft 저장됨 [{account}]\n{preview}\n📁 {path}")
        print(json.dumps({
            "status": "drafted",
            "account": account,
            "media_type": media_type,
            "media_count": len(media_urls),
            "path": path,
            "preview": preview,
            "token_source": source,
        }, ensure_ascii=False))
        return 0

    try:
        result = _real_post(args.caption, media_urls, carousel_types,
                            media_type, access_token, ig_user_id)
    except Exception as e:
        msg = str(e)
        if any(s in msg for s in ("401", "190", "expired", "Invalid")):
            # 토큰 만료 → 한 번 갱신 후 재시도
            from _common import tokens as tokens_mod
            tokens_mod.trigger_refresh(TOKEN_MANAGER_PATH)
            access_token, ig_user_id, source = _resolve_ig_credentials(account)
            try:
                result = _real_post(args.caption, media_urls, carousel_types,
                                    media_type, access_token, ig_user_id)
            except Exception as e2:
                sys.stderr.write(f"❌ Instagram 게시 실패 [{account}]: {e2}\n")
                sys.stderr.write("   → python3 token_manager.py --bootstrap 으로 재발급 권장\n")
                return 1
        else:
            sys.stderr.write(f"❌ Instagram 게시 실패 [{account}]: {e}\n")
            return 1

    print(json.dumps({
        "status": "posted",
        "account": account,
        "permalink": result.get("permalink", ""),
        "media_id": result.get("media_id", ""),
        "token_source": source,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
