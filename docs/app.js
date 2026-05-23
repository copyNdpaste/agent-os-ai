const flowSteps = [
  ['01', '아이디어 투입', '사장님이 만들고 싶은 사업·앱·콘텐츠 아이디어를 채팅에 그대로 입력합니다.'],
  ['02', '본질 분해', '일론머스크가 First Principles와 Musk Algorithm으로 불필요한 요구사항을 제거합니다.'],
  ['03', '고객 검증', '제프베조스가 Working Backwards로 고객 문제, 가격, 구매 이유를 거꾸로 설계합니다.'],
  ['04', '근거 확인', '아인슈타인이 시장·경쟁·데이터를 확인하고 가설의 약한 부분을 표시합니다.'],
  ['05', '실험 발사', '박재범·셰익스피어가 SNS/랜딩/CTA 실험 문구를 만들고 반응 신호를 기록합니다.'],
  ['06', 'MVP 실행', '조나단아이브와 개발신이 최소 제품 경험과 구현 범위를 정하고 실제 산출물로 만듭니다.']
];

const agentCards = [
  {
    name: '일론머스크',
    role: 'Chief Executive Agent',
    image: './assets/agents/elon.png',
    focus: 'First Principles · Musk Algorithm',
    desc: '아이디어를 본질 단위로 쪼개고, 필요 없는 요구사항·단계·기능을 제거합니다.'
  },
  {
    name: '제프베조스',
    role: 'Head of Business',
    image: './assets/agents/bezos.png',
    focus: 'Customer Obsession · Working Backwards',
    desc: '고객이 왜 돈을 내는지, 어떤 가격과 KPI로 검증할지 거꾸로 설계합니다.'
  },
  {
    name: '아인슈타인',
    role: 'Trend & Data Researcher',
    image: './assets/agents/einstein.png',
    focus: '사고실험 · 근거 검증',
    desc: '시장·경쟁·데이터를 확인하고 추정과 사실을 분리해 아이디어의 약점을 찾습니다.'
  },
  {
    name: '조나단아이브',
    role: 'Lead Designer',
    image: './assets/agents/jony.png',
    focus: 'Less but Better',
    desc: '제품 경험을 단순하게 만들고, 사용자가 바로 이해하는 화면과 디자인 원칙을 잡습니다.'
  },
  {
    name: '개발신',
    role: 'Senior Full-Stack Engineer',
    image: './assets/agents/developer-god.png',
    focus: 'Clean Code · BDD/TDD',
    desc: '검증된 범위만 코드로 만들고 테스트·로컬 실행·파일 산출물까지 처리합니다.'
  },
  {
    name: '박재범',
    role: 'Social Director',
    image: './assets/agents/jaybeom.png',
    focus: 'Instagram · X · Threads',
    desc: '아이디어를 플랫폼별 후크, 캡션, 숏폼 스크립트, 댓글 유도 문구로 바꿉니다.'
  },
  {
    name: '셰익스피어',
    role: 'Copywriter',
    image: './assets/agents/shakespeare.png',
    focus: 'AIDA · PAS · Story',
    desc: '첫 문장, 랜딩 카피, 메일, 광고 문구를 구매 행동으로 이어지게 다듬습니다.'
  },
  {
    name: '카리나',
    role: 'Personal Assistant',
    image: './assets/agents/karina.png',
    focus: 'GTD · 일정 · 보고',
    desc: '해야 할 일, 결정 대기, 일정, 알림을 정리해 사장님이 다음 액션만 보게 합니다.'
  },
  {
    name: '한스짐머',
    role: 'Sound Director',
    image: './assets/agents/hans.png',
    focus: 'BGM · 영상 몰입감',
    desc: '영상 실험에 필요한 분위기, 사운드, BGM 방향을 잡아 콘텐츠 완성도를 높입니다.'
  }
];

const collaborationSteps = [
  ['01', 'Goal Intake', '사장님이 목표를 입력하면 CEO가 작업 브리프와 성공 기준을 정합니다.'],
  ['02', 'CEO Planning', '일론머스크가 목표를 분해하고 어떤 에이전트가 어떤 일을 맡을지 계획합니다.'],
  ['03', 'Specialist Work', '제프베조스, 아인슈타인, 조나단아이브, 개발신 등이 각자 산출물을 만듭니다.'],
  ['04', 'Peer Context', '뒤에 실행되는 에이전트는 앞선 동료 산출물을 읽고 자기 결과에 반영합니다.'],
  ['05', 'Confer', '전문가들이 서로 짧게 확인·피드백하며 누락된 부분을 맞춥니다.'],
  ['06', 'CEO Synthesis', 'CEO가 모든 산출물을 하나의 실행 보고서, 우선순위, 다음 액션으로 합칩니다.'],
  ['07', 'Decision Memory', '확정된 판단은 decisions.md와 세션 로그에 저장되어 다음 작업의 기억이 됩니다.'],
  ['08', 'Autonomous Loop', '스케줄러와 비서가 남은 작업, 일정, 반복 보고를 이어받아 목표를 계속 밀어붙입니다.']
];

const automationSteps = [
  {
    num: '01',
    title: '사장님이 아이디어를 던짐',
    input: '“일론머스크야, 이 아이디어가 진짜 만들 가치가 있는지 검증해줘. 필요하면 제프베조스랑 아인슈타인도 불러.”',
    automation: '일론머스크가 문제, 고객, 해결책, 돈이 되는 이유를 분리하고 불필요한 전제를 먼저 제거합니다.',
    output: '_company/sessions/<timestamp>/idea-brief.md'
  },
  {
    num: '02',
    title: '일론머스크가 본질만 남김',
    input: '“이 기능들 중에 진짜 필요한 것만 남겨줘. 1주 안에 검증 못 하는 건 빼.”',
    automation: 'First Principles와 Musk Algorithm 5단계로 요구사항을 의심하고, 제거·단순화·사이클 단축 순서로 정리합니다.',
    output: '삭제할 기능, 남길 핵심 기능, 첫 실험 범위'
  },
  {
    num: '03',
    title: '제프베조스가 고객 관점으로 재작성',
    input: '“고객이 이걸 왜 사야 하는지 보도자료/FAQ 방식으로 써줘. 가격 가설도 넣어줘.”',
    automation: 'Working Backwards로 출시 보도자료, 고객 FAQ, 구매 이유, 가격·KPI 가설을 작성합니다.',
    output: 'PR/FAQ 초안, 고객 가치 제안, 가격 테스트 기준'
  },
  {
    num: '04',
    title: '아인슈타인이 근거를 확인',
    input: '“시장에 이미 비슷한 게 있는지, 사람들이 진짜 이 문제를 말하는지 근거 찾아줘.”',
    automation: '경쟁사, 커뮤니티, 트렌드, 검색 수요를 확인하고 사실·추정·리스크를 신뢰도별로 나눕니다.',
    output: '근거 목록, 경쟁 구도, 검증해야 할 위험'
  },
  {
    num: '05',
    title: '콘텐츠와 랜딩 실험 생성',
    input: '“박재범, 셰익스피어. 이 아이디어를 X, Threads, Instagram, 랜딩 CTA로 테스트할 문구 만들어줘.”',
    automation: '채널별 후크, 짧은 스토리, 댓글 유도 질문, 대기자 신청 CTA를 만들고 실험 파일로 저장합니다.',
    output: 'SNS 게시안, 랜딩 카피, A/B 테스트 문구'
  },
  {
    num: '06',
    title: 'MVP 실행 계획과 산출물 생성',
    input: '“조나단아이브는 최소 화면을 잡고, 개발신은 이번 주에 만들 수 있는 MVP 체크리스트와 파일 구조를 만들어줘.”',
    automation: '디자인 원칙, 화면 구조, BDD 시나리오, 구현 순서, 테스트 기준을 만들고 필요한 파일을 생성·수정합니다.',
    output: 'MVP 스펙, 화면 설계, 개발 체크리스트, 테스트 계획'
  }
];

const exampleFlowStages = [
  {
    id: 'idea',
    label: '아이디어',
    title: '사장님 입력',
    agent: 'User → 일론머스크',
    node: '문제·고객·해결책이 아직 섞여 있는 원석 상태',
    data: ['원문 아이디어', '목표', '제약 조건'],
    reaction: '아직 외부 반응 없음',
    outcome: 'CEO가 검증 가능한 질문으로 쪼갬'
  },
  {
    id: 'strategy',
    label: '전략 분해',
    title: '본질과 고객 가치 정리',
    agent: '일론머스크 · 제프베조스',
    node: 'First Principles로 줄이고 Working Backwards로 고객 관점 재작성',
    data: ['핵심 문제', '삭제할 기능', '가격 가설', '고객 FAQ'],
    reaction: '내부 기준: 1주 안에 검증 가능한가',
    outcome: '실험해야 할 단일 가설과 성공 기준 생성'
  },
  {
    id: 'research',
    label: '근거 확인',
    title: '시장·경쟁·리스크 검사',
    agent: '아인슈타인',
    node: '추정과 사실을 분리하고, 약한 가설을 먼저 찾음',
    data: ['경쟁 제품', '커뮤니티 불만', '검색 수요', '리스크'],
    reaction: '신뢰도 A/B/C/D로 근거 등급화',
    outcome: '버릴 가설과 더 세게 테스트할 가설 분리'
  },
  {
    id: 'experiment',
    label: '실험 발사',
    title: 'SNS·랜딩으로 외부 반응 받기',
    agent: '박재범 · 셰익스피어',
    node: '같은 아이디어를 채널별 후크와 CTA로 변환',
    data: ['X 문구', 'Threads 질문', 'Instagram 릴스 훅', '랜딩 CTA'],
    reaction: '댓글, DM, 저장, 클릭, 대기자 신청이 들어옴',
    outcome: '좋아요보다 강한 행동 신호를 수집'
  },
  {
    id: 'signals',
    label: '반응 분석',
    title: '유저 반응을 점수화',
    agent: '제프베조스 · 카리나',
    node: '반응을 기록하고 구매 의향에 가까운 신호에 가중치 부여',
    data: ['댓글 18', 'DM 4', '대기자 23', '저장 41'],
    reaction: '강한 신호: 대기자·DM·결제 의향 / 약한 신호: 조회·좋아요',
    outcome: 'Idea Score와 다음 액션이 결정됨'
  },
  {
    id: 'mvp',
    label: 'MVP 결정',
    title: '만들 것만 남기고 실행',
    agent: '조나단아이브 · 개발신',
    node: '최소 화면, BDD 시나리오, 파일 구조, 테스트 계획으로 전환',
    data: ['MVP 스펙', '화면 구조', '개발 체크리스트', '테스트 기준'],
    reaction: '사용자 피드백을 다음 실험 루프로 다시 투입',
    outcome: '작은 제품 또는 랜딩이 실제 산출물로 생성'
  }
];

const treeItems = [
  {
    level: 0,
    icon: 'B',
    label: '~/.agent-os-ai-brain/',
    path: '로컬 지식 루트',
    title: '로컬 Markdown Brain',
    desc: '아이디어, 실험 결과, 결정 로그, 에이전트 메모가 저장되는 기본 폴더입니다. GitHub 동기화는 선택 사항입니다.'
  },
  {
    level: 1,
    icon: 'C',
    label: '_company/',
    path: '~/.agent-os-ai-brain/_company/',
    title: '실험 워크스페이스',
    desc: '아이디어 실험실의 운영 데이터가 들어갑니다. 대시보드, 에이전트, 세션, 승인 기록이 이 구조를 기준으로 움직입니다.'
  },
  {
    level: 2,
    icon: 'S',
    label: '_shared/identity.md',
    path: '_company/_shared/identity.md',
    title: '실험실 정체성',
    desc: '타깃 시장, 브랜드 톤, 금기, 핵심 가치를 저장합니다. 모든 에이전트가 매번 참고합니다.'
  },
  {
    level: 2,
    icon: 'G',
    label: '_shared/goals.md',
    path: '_company/_shared/goals.md',
    title: '수요검증 목표',
    desc: '이번 달 검증할 아이디어 수, 게시할 콘텐츠 수, MVP 후보 기준 같은 운영 목표를 기록합니다.'
  },
  {
    level: 2,
    icon: 'D',
    label: '_shared/decisions.md',
    path: '_company/_shared/decisions.md',
    title: '결정 로그',
    desc: '왜 이 아이디어를 버렸는지, 왜 MVP로 올렸는지 같은 판단 근거를 누적합니다. 다음 의사결정의 가장 강한 컨텍스트입니다.'
  },
  {
    level: 2,
    icon: 'A',
    label: '_agents/<id>/memory.md',
    path: '_company/_agents/<id>/memory.md',
    title: '에이전트별 메모리',
    desc: 'Social, Business, Researcher 같은 에이전트가 자기 영역에서 배운 패턴을 기록합니다.'
  },
  {
    level: 2,
    icon: 'P',
    label: '_agents/<id>/prompt.md',
    path: '_company/_agents/<id>/prompt.md',
    title: '에이전트별 지시',
    desc: '각 에이전트의 말투, 취향, 추가 규칙을 사용자가 직접 조정하는 파일입니다.'
  },
  {
    level: 2,
    icon: 'T',
    label: 'sessions/<timestamp>/',
    path: '_company/sessions/',
    title: '세션 산출물',
    desc: '채팅 세션 중 생성된 기획안, 코드, 실험 문구, 리포트가 시간 단위로 저장됩니다.'
  }
];

const graphGroups = [
  ['아이디어', '#6aa8ff', '새 제품/서비스 컨셉'],
  ['고객', '#60d394', '타깃, 페르소나, 시장'],
  ['문제', '#ef7aa4', '불편, 니즈, 정보 비대칭'],
  ['가설', '#b692ff', '검증할 전제와 기준'],
  ['실험', '#f2c46d', 'SNS 게시, 랜딩, CTA'],
  ['반응', '#5ed7df', '댓글, DM, 클릭, 신청'],
  ['수익화', '#9bd37a', '가격, BM, 결제 신호'],
  ['리스크', '#f27c7c', '법률, 약관, 개인정보'],
  ['MVP', '#c6d4ff', '만들 후보와 개발 범위']
];

const modules = [
  ['core', 'src/extension.ts', '확장 진입점. 명령 등록, 설정, 활성화, 주요 의존성 wiring을 담당합니다.', ['activate', 'commands', 'config']],
  ['core', 'src/agents.ts', '9개 에이전트의 이름, 역할, 전문성, 페르소나, 모델 tier를 정의합니다.', ['agents', 'persona']],
  ['brain', 'src/brain/', 'Markdown 지식 검색, RAG 컨텍스트, 그래프 빌드, 키워드 추출을 담당합니다.', ['graph', 'rag', 'keywords']],
  ['brain', 'src/company/', '실험 워크스페이스 폴더 구조, goals.md, identity.md, metrics를 관리합니다.', ['workspace', 'memory']],
  ['ui', 'src/views/', '사이드바, 대시보드, 그래프, API 연결, 수익 대시보드 Webview를 만듭니다.', ['webview', 'dashboard']],
  ['workflow', 'src/dispatch/', '사용자 요청을 어떤 에이전트에게 보낼지 판단하는 활성 dispatch 상태를 관리합니다.', ['routing']],
  ['workflow', 'src/scheduler/', '반복 작업, tick runner, 플래너, 스케줄 저장소를 담당합니다.', ['scheduler', 'loop']],
  ['integrations', 'src/youtube/', 'YouTube OAuth와 Analytics 연동을 담당합니다. 유튜브 실험/분석 아이디어의 기반입니다.', ['youtube', 'analytics']],
  ['integrations', 'src/telegram/', '텔레그램 알림, 명령, polling, history를 담당합니다.', ['telegram', 'notify']],
  ['integrations', 'src/api-connections/', 'Google, PayPal, Slack 등 외부 API 키를 한 곳에서 저장하고 읽습니다.', ['api', 'secrets']],
  ['tools', 'assets/tool-seeds/', '에이전트에게 주입되는 Python/Markdown 도구 시드입니다.', ['tools', 'seeds']],
  ['tools', 'assets/brain-seeds/', 'MVP나 랜딩에 재사용할 템플릿 팩입니다.', ['templates', 'packs']]
];

const timeline = [
  ['Capture', '아이디어를 놓치지 않도록 Markdown 또는 채팅으로 빠르게 기록합니다.'],
  ['Clarify', '타깃, 문제, 숨겨진 정보, 대체재, 가설을 구조화합니다.'],
  ['Publish', 'SNS별 문구와 CTA를 만들어 외부 반응을 확인합니다.'],
  ['Measure', '좋아요보다 댓글, DM, 클릭, 대기자, 결제 의향 같은 강한 신호를 봅니다.'],
  ['Decide', '결정 로그에 남기고, 상위 아이디어만 MVP 후보로 이동합니다.'],
  ['Build', 'Developer 에이전트가 작은 MVP를 만들고 다시 실험 루프로 돌립니다.']
];

const filters = ['all', 'core', 'brain', 'ui', 'workflow', 'integrations', 'tools'];

function renderFlow() {
  const root = document.getElementById('flowGrid');
  root.innerHTML = flowSteps.map(([num, title, desc]) => `
    <article class="flow-step">
      <span class="num">${num}</span>
      <strong>${title}</strong>
      <p>${desc}</p>
    </article>
  `).join('');
}

function renderAgents() {
  const root = document.getElementById('agentGrid');
  root.innerHTML = agentCards.map(({ name, role, image, focus, desc }) => `
    <article class="agent-card">
      <img src="${image}" alt="${name} portrait">
      <div>
        <span>${role}</span>
        <h3>${name}</h3>
        <strong>${focus}</strong>
        <p>${desc}</p>
      </div>
    </article>
  `).join('');
}

function renderCollaboration() {
  const root = document.getElementById('collabPipeline');
  root.innerHTML = collaborationSteps.map(([num, title, desc]) => `
    <article class="pipeline-step">
      <span>${num}</span>
      <strong>${title}</strong>
      <p>${desc}</p>
    </article>
  `).join('');
}

function renderAutomationFlow() {
  const root = document.getElementById('automationFlow');
  root.innerHTML = automationSteps.map(({ num, title, input, automation, output }) => `
    <article class="automation-step">
      <div class="automation-index">${num}</div>
      <div>
        <h3>${title}</h3>
        <div class="automation-columns">
          <div>
            <span>입력</span>
            <p>${input}</p>
          </div>
          <div>
            <span>자동화</span>
            <p>${automation}</p>
          </div>
          <div>
            <span>산출물</span>
            <p>${output}</p>
          </div>
        </div>
      </div>
    </article>
  `).join('');
}

function renderExampleGraph() {
  const root = document.getElementById('exampleGraph');
  const nodeMarkup = exampleFlowStages.map((stage, index) => `
    <button class="graph-node ${index === 0 ? 'active' : ''}" type="button" data-stage="${index}" style="--i:${index};--row:${index % 2}">
      <span>${String(index + 1).padStart(2, '0')}</span>
      <strong>${stage.label}</strong>
    </button>
  `).join('');

  root.innerHTML = `
    <div class="graph-canvas">
      <svg class="graph-lines" viewBox="0 0 1000 360" preserveAspectRatio="none" aria-hidden="true">
        <path class="graph-backbone" d="M80 180 C220 70, 330 292, 470 180 S720 70, 900 180" />
        <path class="graph-flow-line" d="M80 180 C220 70, 330 292, 470 180 S720 70, 900 180" />
      </svg>
      <div class="graph-packets" aria-hidden="true">
        <span></span><span></span><span></span>
      </div>
      <div class="graph-nodes">${nodeMarkup}</div>
    </div>
    <div class="graph-detail" id="graphDetail"></div>
  `;

  const detail = document.getElementById('graphDetail');
  const buttons = Array.from(root.querySelectorAll('.graph-node'));
  let activeIndex = 0;
  let timer = null;

  const draw = (index) => {
    activeIndex = index;
    const stage = exampleFlowStages[index];
    root.style.setProperty('--active-index', index);
    buttons.forEach((button, buttonIndex) => {
      button.classList.toggle('active', buttonIndex === index);
      button.classList.toggle('complete', buttonIndex < index);
    });
    detail.innerHTML = `
      <span class="path">${stage.agent}</span>
      <h3>${stage.title}</h3>
      <p>${stage.node}</p>
      <div class="graph-detail-grid">
        <div>
          <strong>흐르는 데이터</strong>
          <ul>${stage.data.map(item => `<li>${item}</li>`).join('')}</ul>
        </div>
        <div>
          <strong>유저 반응</strong>
          <p>${stage.reaction}</p>
        </div>
        <div>
          <strong>다음 산출물</strong>
          <p>${stage.outcome}</p>
        </div>
      </div>
    `;
  };

  const restart = () => {
    if (timer) clearInterval(timer);
    timer = setInterval(() => draw((activeIndex + 1) % exampleFlowStages.length), 3200);
  };

  root.addEventListener('click', (event) => {
    const button = event.target.closest('.graph-node');
    if (!button) return;
    draw(Number(button.dataset.stage));
    restart();
  });

  draw(0);
  restart();
}

function renderTree() {
  const root = document.getElementById('fileTree');
  const card = document.getElementById('brainCard');
  root.innerHTML = treeItems.map((item, index) => `
    <button class="tree-item indent-${item.level}" data-index="${index}" type="button">
      <span class="tree-badge">${item.icon}</span>
      <span>${item.label}</span>
    </button>
  `).join('');

  root.addEventListener('click', (event) => {
    const button = event.target.closest('.tree-item');
    if (!button) return;
    root.querySelectorAll('.tree-item').forEach(el => el.classList.remove('active'));
    button.classList.add('active');
    const item = treeItems[Number(button.dataset.index)];
    card.innerHTML = `
      <p class="eyebrow">선택된 항목</p>
      <h3>${item.title}</h3>
      <span class="path">${item.path}</span>
      <p>${item.desc}</p>
    `;
  });
}

function renderLegend() {
  const root = document.getElementById('legendGrid');
  root.innerHTML = graphGroups.map(([name, color, desc]) => `
    <div class="legend-item">
      <span class="swatch" style="background:${color}"></span>
      <span><strong>${name}</strong><br><small>${desc}</small></span>
    </div>
  `).join('');
}

function renderFilters() {
  const root = document.getElementById('filters');
  root.innerHTML = filters.map((filter, index) => `
    <button class="filter-btn ${index === 0 ? 'active' : ''}" type="button" data-filter="${filter}">
      ${filter === 'all' ? '전체' : filter}
    </button>
  `).join('');

  root.addEventListener('click', (event) => {
    const button = event.target.closest('.filter-btn');
    if (!button) return;
    root.querySelectorAll('.filter-btn').forEach(el => el.classList.remove('active'));
    button.classList.add('active');
    renderModules(button.dataset.filter);
  });
}

function renderModules(filter = 'all') {
  const root = document.getElementById('moduleGrid');
  const list = filter === 'all' ? modules : modules.filter(([type]) => type === filter);
  root.innerHTML = list.map(([type, path, desc, tags]) => `
    <article class="module-card">
      <span class="path">${path}</span>
      <h3>${type}</h3>
      <p>${desc}</p>
      <div class="chips">${tags.map(tag => `<span class="chip">${tag}</span>`).join('')}</div>
    </article>
  `).join('');
}

function renderTimeline() {
  const root = document.getElementById('timeline');
  root.innerHTML = timeline.map(([step, desc], index) => `
    <article class="timeline-item">
      <time>${String(index + 1).padStart(2, '0')} / ${step}</time>
      <p>${desc}</p>
    </article>
  `).join('');
}

renderAgents();
renderCollaboration();
renderFlow();
renderExampleGraph();
renderAutomationFlow();
renderTree();
renderLegend();
renderFilters();
renderModules();
renderTimeline();
