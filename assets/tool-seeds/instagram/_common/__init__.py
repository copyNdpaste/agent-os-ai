"""Instagram/Threads/X uploader 공통 모듈.

각 uploader 가 복붙해 쓰던 헬퍼들을 한 곳에 모아 단일 출처(SSOT)로 둠.
하위 모듈:
    - drafts:      drafts/ 디렉터리, frontmatter 빌더
    - telegram:    텔레그램 알림
    - http:        urllib 기반 HTTP 헬퍼 (form-POST, GET, JSON-body POST, multipart)
    - tokens:      tokens.json 로드/저장, 만료 계산, 자동 갱신 트리거
    - credentials: 플랫폼별 자격증명 해석 (tokens.json → env fallback)
"""
