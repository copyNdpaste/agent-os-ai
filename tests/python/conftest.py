"""pytest 공통 설정 — sys.path 에 uploader 디렉터리를 추가해
`_common` 모듈을 import 가능하게 한다.
"""
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
UPLOADER_DIR = os.path.join(ROOT, "assets", "tool-seeds", "instagram")
if UPLOADER_DIR not in sys.path:
    sys.path.insert(0, UPLOADER_DIR)
