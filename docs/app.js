const flowSteps = [
  ['01', '아이디어 기록', '문제, 타깃, 기존 대안, 한 줄 가설을 Markdown으로 저장합니다.'],
  ['02', '실험 설계', 'SNS 채널별 메시지, CTA, 랜딩 링크, 성공 기준을 정합니다.'],
  ['03', '콘텐츠 게시', 'Threads, X, Instagram, Shorts에 서로 다른 각도로 던집니다.'],
  ['04', '반응 수집', '댓글, DM, 클릭, 저장, 공유, 대기자 등록을 기록합니다.'],
  ['05', '그래프 연결', '아이디어·문제·반응·수익화 노드를 자동으로 묶습니다.'],
  ['06', 'MVP 결정', '강한 신호가 있는 아이디어만 개발 후보로 올립니다.']
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

renderFlow();
renderTree();
renderLegend();
renderFilters();
renderModules();
renderTimeline();
