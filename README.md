<h1 align="center">Agent OS</h1>

<p align="center">
  <strong>1인 기업 AI 운영 OS · VS Code 확장</strong><br/>
  9 명의 전문 에이전트가 한 회사처럼 협업합니다.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license" />
  <img src="https://img.shields.io/badge/engine-Claude_Code_CLI-orange" alt="engine" />
  <img src="https://img.shields.io/badge/powered_by-Claude_Opus_4.7-purple" alt="claude" />
</p>

---

## 🌟 Overview

VS Code 계열 IDE 확장. 사장님 (operator) 한 명이 **CEO 일론머스크 + 8 명의 전문가 에이전트**를 거느리는 1인 AI 회사를 운영합니다. 각 에이전트는 자기 분야의 사고법·원칙을 체득한 캐릭터로 동작합니다 — 단순 LLM 래퍼가 아닙니다.

---

## 🏢 9 명의 에이전트

| 역할 | 이름 | 핵심 사고 프레임워크 | Tier |
|:--|:--|:--|:--|
| 🧭 CEO | **일론머스크** | 제 1원칙(First Principles) + Musk Algorithm 5-step (의심·제거·단순화·사이클·자동화) | Heavy |
| ✨ Head of Social | **박재범** | Instagram·X·Threads 3채널 마스터, 2030 KR/JP 여성 타겟, K/J 바이링구얼 | Heavy |
| 🎨 Lead Designer | **조나단아이브** | Dieter Rams 좋은 디자인 10원칙 · Less but Better | Standard |
| 💻 Senior Engineer | **개발신** | Clean Code (Uncle Bob) + Clean Architecture + BDD/TDD + SOLID | Heavy |
| 💼 Head of Business | **제프베조스** | Customer Obsession + Working Backwards + Day 1 + Two-way door | Heavy |
| 📱 Personal Assistant | **카리나** | GTD 5단계 + Eisenhower Matrix 2x2 | Light |
| 🎵 Sound Director | **한스짐머** | 모티프 작곡 4원칙 (압축·반복변주·침묵·counter-melody) | Standard |
| ✍️ Copywriter | **셰익스피어** | AIDA + PAS + Hero's Journey + Ogilvy 데이터 드리븐 | Standard |
| 🔍 Researcher | **아인슈타인** | Gedankenexperiment + Occam's Razor + 신뢰도 등급(A~D) | Standard |

각 에이전트의 `persona` 가 시스템 프롬프트에 주입돼, 해당 사고법대로 답변·작업합니다.

---

## ⚡ Core Features

### 🧠 자율 지식 정원사
사장님이 던지는 raw 데이터를 에이전트가 **스스로 의미 분석 → 폴더 생성 → Markdown wiki 정리 → 클라우드 자동 백업** 까지 수행합니다.

### 📂 Zero-Interaction 지식 구조화
원시 데이터를 `10_Wiki`, `00_Raw`, `🚀 Skills` 등 일관된 마크다운 템플릿으로 자동 분할·조립.

### ☁️ Auto-Git Sync
파일 생성 즉시 에이전트가 `git add`, `commit`, `push` 자동 수행.

### 🔗 Claude 3-Tier 자동 라우팅
| Tier | 모델 | 용도 |
|:--|:--|:--|
| **Heavy** | Claude Opus 4.7 | 사업 평가·코드 생성·핵심 의사결정 |
| **Standard** | Claude Sonnet 4.6 | 일상 에이전트 업무 |
| **Light** | Claude Haiku 4.5 | 요약·스코어링·분류 |

업무 난이도에 따라 CEO 가 알아서 모델 라우팅.

---

## ⚒️ Agent Capabilities

권한 승인 기반으로 로컬 파일시스템·터미널 통제권 부여:

| Action | Description |
|:--|:--|
| 📄 Create Files | 새 파일·폴더 생성 |
| ✏️ Edit Files | 코드 수정 |
| 🗑️ Delete Files | 불필요 파일 삭제 |
| 📖 Read Files | 프로젝트 파일 읽어 맥락 파악 |
| 📂 Browse Directories | 디렉토리 구조 분석 |
| 🖥️ Run Commands | `npm run build`, `git push` 등 터미널 명령 |

---

## 📥 Installation

### Build from Source
```bash
git clone https://github.com/copyNdpaste/agent-os-ai.git
cd agent-os-ai
npm install
npm run compile
# F5 (VS Code) 로 Extension Development Host 실행
# 또는 .vsix 패키지: npx vsce package
```

### 사전 요구 사항
`claude` CLI 설치:
```bash
npm install -g @anthropic-ai/claude-code
claude login
claude --version  # 동작 확인
```

설치 후 자동 인식. 비표준 위치 (예: nvm·homebrew) 도 자동 탐색합니다.

---

## 🤖 Claude Powered

**Claude Code CLI** 위에서 동작. 사장님이 보유한 **Claude Max 구독**이 모든 LLM 호출을 처리합니다. 별도 API 키 발급·요금 정산 없음.

---

## 🤝 Companion Repo

한일 SNS 자동 컨텐츠 봇 (Threads/Instagram/X 멀티 계정, 자율 회차):
- 👉 https://github.com/copyNdpaste/content-bot-ai

---

## 📜 Origin

이 프로젝트는 https://github.com/wonseokjung/connect-ai 를 clone 해서 시작했습니다. 이후 9 에이전트 페르소나 재설계, Clean Architecture Phase 1 모듈 분리, Threads/IG/X 자동 게시 통합 등 대규모 개편을 거쳤습니다.
