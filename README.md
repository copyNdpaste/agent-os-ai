<h1 align="center">Agent OS AI</h1>

<p align="center">
  <strong>1인 기업을 위한 아이디어 실험·수요검증 OS</strong><br/>
  아이디어를 만들고, SNS 실험으로 시장 반응을 확인하고, 반응 좋은 것만 MVP로 전환합니다.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license" />
  <img src="https://img.shields.io/badge/engine-Claude_Code_CLI-orange" alt="engine" />
  <img src="https://img.shields.io/badge/focus-Idea_Validation-blue" alt="idea validation" />
</p>

<p align="center">
  <a href="https://copyNdpaste.github.io/agent-os-ai/"><strong>시각화 문서 열기</strong></a>
  ·
  <a href="#how-it-works">작동 방식</a>
  ·
  <a href="#folder-map">폴더 구조</a>
  ·
  <a href="#installation">설치</a>
</p>

<p align="center">
  <a href="https://copyNdpaste.github.io/agent-os-ai/">
    <img src="https://img.shields.io/badge/GitHub_Pages-Architecture_Viewer-6aa8ff?style=for-the-badge" alt="Open visual architecture page" />
  </a>
</p>

---

## What Is This?

Agent OS AI는 VS Code 계열 IDE 안에서 돌아가는 개인용 실험 운영체제입니다. 목적은 "AI 직원 놀이"가 아니라, 1인 창업자가 매일 떠오르는 아이디어를 구조화하고 외부 채널에 던져서 수요를 확인하는 것입니다.

> 더 보기 좋은 구조 설명은 GitHub Pages에서 확인하세요:  
> https://copyNdpaste.github.io/agent-os-ai/

## How It Works

```text
아이디어 기록
→ 타깃/문제/가설 정리
→ Instagram/X/Threads/YouTube Shorts 실험 문구 생성
→ 게시·반응 기록
→ 지식 그래프로 패턴 확인
→ 반응 좋은 아이디어만 MVP 제작
```

| 단계 | 하는 일 | 산출물 |
|---:|---|---|
| 1 | 아이디어 기록 | 문제, 타깃, 숨겨진 정보, 가설 |
| 2 | 실험 설계 | Threads/X/Instagram/Shorts 문구, CTA |
| 3 | 반응 수집 | 댓글, DM, 클릭, 저장, 대기자 등록 |
| 4 | 그래프 연결 | 아이디어·문제·고객·반응 노드 |
| 5 | MVP 결정 | 만들 것/버릴 것/나중에 볼 것 |

## Core Features

### 아이디어 실험 메모리

아이디어, 고객 가설, 문제 정의, 실험 문구, 반응 데이터, 결정 로그를 Markdown으로 저장합니다. 각 문서는 Git으로 백업할 수 있고, 민감한 개인 아이디어 문서는 `.gitignore`로 제외할 수 있습니다.

### 수요검증 지식 그래프

Markdown 노드를 단순 파일 목록으로 보여주지 않고, 내용 기반으로 `아이디어`, `고객`, `문제`, `가설`, `실험`, `반응`, `MVP`, `수익화`, `리스크` 같은 그룹을 추론해 색상별로 보여줍니다. 한눈에 어떤 키워드가 반복되는지, 어떤 아이디어가 어떤 실험과 연결되는지 볼 수 있습니다.

### SNS 실험 운영

Social 에이전트가 하나의 아이디어를 플랫폼별 포맷으로 쪼갭니다.

- Threads/X: 문제 제기, 논쟁 유도, 짧은 인사이트
- Instagram: 릴스/카루셀/스토리 투표 문구
- YouTube Shorts: 개인 경험 기반 훅
- 랜딩/대기자 모집용 CTA

### 다음 MVP 결정

Business/Researcher 에이전트가 댓글, DM, 클릭, 대기자 등록 같은 강한 신호를 기준으로 Idea Score를 계산하고, 어떤 아이디어를 만들지 우선순위를 제안합니다.

### 개발 실행

Developer 에이전트는 반응이 확인된 아이디어만 빠르게 MVP로 만듭니다. 코드 생성, 파일 수정, 테스트, 로컬 미리보기, API 연결을 담당합니다.

## Folder Map

```text
~/.agent-os-ai-brain/
└── _company/
    ├── _shared/
    │   ├── identity.md      # 실험실 정체성, 타깃, 톤
    │   ├── goals.md         # 수요검증 목표
    │   ├── decisions.md     # 결정 로그
    │   └── _system.md       # 폴더 사용 매뉴얼
    ├── _agents/<agent>/
    │   ├── memory.md        # 에이전트별 학습 로그
    │   ├── prompt.md        # 에이전트별 추가 지시
    │   └── skills/          # 검증된 재사용 패턴
    └── sessions/            # 세션별 산출물
```

## Knowledge Graph

Markdown 파일은 지식 그래프의 노드가 됩니다. Agent OS AI는 파일 내용에서 의미를 추론해 아래 그룹으로 색상 분류합니다.

| 그룹 | 의미 |
|---|---|
| 아이디어 | 새 제품/서비스 컨셉 |
| 고객 | 타깃, 페르소나, 시장 |
| 문제 | 불편, 니즈, 정보 비대칭 |
| 가설 | 검증할 전제 |
| 실험 | SNS 게시, 랜딩, CTA |
| 반응 | 댓글, DM, 클릭, 신청 |
| 수익화 | 가격, BM, 결제 신호 |
| 리스크 | 법률, 약관, 개인정보 |
| MVP | 만들 후보와 개발 범위 |

## Agents

| 역할 | 담당 |
|:--|:--|
| CEO | 아이디어 우선순위, 실험 계획, 다음 액션 결정 |
| Social | Instagram/X/Threads/Shorts 실험 콘텐츠 생성 |
| Researcher | 시장·경쟁·근거 리서치, 사실 확인 |
| Business | 가격, BM, KPI, Idea Score 설계 |
| Writer | 후크, CTA, 랜딩 카피, 스크립트 |
| Designer | 썸네일, 카루셀, 랜딩 UI 방향 |
| Developer | MVP 구현, 자동화, 테스트 |
| Secretary | 일정, 실험 캘린더, 리마인드, 브리핑 |
| Editor | 숏폼/영상용 사운드와 편집 보조 |

## Suggested Workflow

1. 아이디어를 Markdown으로 기록합니다.
2. CEO에게 "이 아이디어 SNS 실험 설계해줘"라고 요청합니다.
3. Social/Writer가 플랫폼별 게시글을 만듭니다.
4. 게시 후 반응 수치를 기록합니다.
5. 지식 그래프에서 반복 키워드와 강한 신호를 확인합니다.
6. 반응 상위 1~2개만 MVP로 만듭니다.

## Installation

```bash
git clone https://github.com/copyNdpaste/agent-os-ai.git
cd agent-os-ai
npm install
npm run compile
# F5로 Extension Development Host 실행
# 또는 .vsix 패키지: npx vsce package
```

### Requirements

Claude Code CLI:

```bash
npm install -g @anthropic-ai/claude-code
claude login
claude --version
```

## Local Data

기본 지식 폴더는 `~/.agent-os-ai-brain/`입니다. 아이디어와 실험 로그는 로컬에 저장되며, 사용자가 원할 때만 GitHub 저장소와 동기화합니다.

## Project Status

이 프로젝트는 개인 아이디어 실험과 수요검증을 빠르게 반복하기 위한 로컬 우선 VS Code 확장으로 관리됩니다.

## Visual Documentation

GitHub repo 첫 화면은 GitHub 정책상 `README.md`가 렌더링됩니다. 인터랙티브 HTML/CSS/JS 문서는 GitHub Pages에서 볼 수 있습니다.

- Repo: https://github.com/copyNdpaste/agent-os-ai
- Pages: https://copyNdpaste.github.io/agent-os-ai/
