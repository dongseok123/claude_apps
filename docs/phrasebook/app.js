import { askJSON, S } from './claude.js';
import { canSpeak, speak } from './speak.js';

// ---------- Storage and settings ----------

const store = {
  get(key, fallback) {
    try {
      const value = localStorage.getItem(`pb.${key}`);
      return value == null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`pb.${key}`, JSON.stringify(value));
    } catch {}
  },
  remove(key) {
    try {
      localStorage.removeItem(`pb.${key}`);
    } catch {}
  },
};

/** The key saved here, or the one saved in Talkback on the same site. */
function apiKey() {
  const own = store.get('apiKey', '');
  if (own) return own;
  try {
    return JSON.parse(localStorage.getItem('tb.apiKey') || '""');
  } catch {
    return '';
  }
}

const RATES = [0.75, 0.9, 1, 1.2];
const TONES = {
  formal: { label: '격식', english: 'formal and polite (work, customers, strangers)' },
  neutral: { label: '보통', english: 'neutral and friendly, for everyday situations' },
  casual: { label: '캐주얼', english: 'casual, as between close friends' },
};
const DICTIONARIES = {
  naver: { label: '네이버', url: (q) => `https://en.dict.naver.com/#/search?query=${encodeURIComponent(q)}` },
  daum: { label: '다음', url: (q) => `https://dic.daum.net/search.do?q=${encodeURIComponent(q)}&dic=eng` },
  cambridge: {
    label: 'Cambridge',
    url: (q) => `https://dictionary.cambridge.org/search/direct/?datasetsearch=english-korean&q=${encodeURIComponent(q)}`,
  },
};
const EXAMPLES = [
  '회의에 10분 늦을 것 같다고 팀장님께 말하고 싶어',
  '친구 초대를 기분 상하지 않게 거절하고 싶어',
  '식당에서 주문한 음식과 다른 게 나왔어',
  '처음 만난 사람에게 무슨 일 하는지 자연스럽게 묻고 싶어',
];

const PHRASES_SCHEMA = S.obj({
  phrases: S.arr(S.obj({ en: S.str, ko: S.str, tip: S.str })),
});

const settings = { speechRate: 0.9, ...store.get('settings', {}) };
const saveSettings = () => store.set('settings', settings);

const state = {
  tab: 'situation',
  dict: { query: '', searched: '', source: store.get('dictSource', 'naver') },
  sit: { text: '', tone: 'neutral', phrases: [], searched: '', loading: false, error: '' },
};

const $view = document.getElementById('view');
const $toast = document.getElementById('toast');

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function toast(message) {
  $toast.textContent = message;
  $toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    $toast.hidden = true;
  }, 2200);
}

const ICON = {
  speaker: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/></svg>',
  external: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
};

const speakButton = (text) =>
  canSpeak
    ? `<button type="button" class="icon-btn" data-action="say" data-text="${esc(text)}" aria-label="원어민 발음 듣기">${ICON.speaker}</button>`
    : '';

const segmented = (action, options, current, label) => `
  <div class="segmented" role="group" aria-label="${esc(label)}">
    ${options
      .map(
        ([value, text]) =>
          `<button type="button" data-action="${action}" data-value="${esc(value)}" aria-pressed="${String(value) === String(current)}">${esc(text)}</button>`,
      )
      .join('')}
  </div>`;

// ---------- Tabs ----------

function renderSituation() {
  const sit = state.sit;
  const needsKey = !apiKey();
  return `
    <header class="page-head">
      <div>
        <span class="muted">상황을 한국어로 적으면 원어민 표현을 알려줘요</span>
        <h1>이럴 땐 영어로?</h1>
      </div>
    </header>
    ${
      needsKey
        ? `<section class="card notice">
            <h2>Claude API 키가 필요해요</h2>
            <p>설정 탭에서 키를 한 번만 넣으면 돼요.</p>
            <button type="button" class="btn primary" data-tab="settings">설정으로 가기</button>
          </section>`
        : ''
    }
    <section class="card">
      <label class="visually-hidden" for="sit-text">상황 설명</label>
      <textarea id="sit-text" rows="3" placeholder="예: 회의에 10분 늦을 것 같다고 팀장님께 정중하게 말하고 싶어">${esc(sit.text)}</textarea>
      <div class="row-actions">
        <span class="footnote">키보드의 🎤로 말해서 적어도 돼요</span>
        <button type="button" class="btn primary" data-action="sit-find" ${sit.loading ? 'disabled' : ''}>표현 찾기</button>
      </div>
    </section>
    <h2 class="section-title">말투</h2>
    ${segmented('sit-tone', Object.entries(TONES).map(([k, t]) => [k, t.label]), sit.tone, '말투')}
    ${sit.loading ? `<section class="card loading"><span class="spinner" aria-hidden="true"></span>원어민 표현을 찾는 중이에요…</section>` : ''}
    ${sit.error ? `<section class="card error"><p>${esc(sit.error)}</p></section>` : ''}
    ${
      sit.phrases.length
        ? `<h2 class="section-title">이렇게 말해 보세요</h2>
          <ul class="list phrases">
            ${sit.phrases
              .map(
                (p) => `
              <li class="phrase">
                <div class="phrase-head">
                  <strong>${esc(p.en)}</strong>
                  <div class="phrase-actions">
                    ${speakButton(p.en)}
                    <button type="button" class="icon-btn" data-action="copy" data-text="${esc(p.en)}" aria-label="복사">${ICON.copy}</button>
                  </div>
                </div>
                <span class="muted">${esc(p.ko)}</span>
                <p class="tip">${esc(p.tip)}</p>
              </li>`,
              )
              .join('')}
          </ul>`
        : sit.loading
          ? ''
          : `<h2 class="section-title">예시 상황</h2>
            <ul class="list">
              ${EXAMPLES.map((ex, i) => `<li><button type="button" class="row" data-action="sit-example" data-index="${i}"><span>${esc(ex)}</span></button></li>`).join('')}
            </ul>`
    }`;
}

function renderDictionary() {
  const { query, searched, source } = state.dict;
  const recents = store.get('recentWords', []);
  const isEnglish = /[A-Za-z]/.test(searched);
  return `
    <header class="page-head"><h1>영한사전</h1></header>
    <form id="dict-form" class="search" autocomplete="off">
      <label class="visually-hidden" for="dict-q">단어 또는 표현</label>
      <input id="dict-q" name="q" type="search" enterkeyhint="search" placeholder="영어 단어나 표현 (한국어도 돼요)" value="${esc(query)}" autocapitalize="off" autocorrect="off" spellcheck="false">
      <button type="submit" class="btn primary">검색</button>
    </form>
    ${segmented('dict-source', Object.entries(DICTIONARIES).map(([k, d]) => [k, d.label]), source, '사전 선택')}
    ${
      recents.length
        ? `<div class="chips">${recents.map((w) => `<button type="button" class="chip" data-action="dict-recent" data-value="${esc(w)}">${esc(w)}</button>`).join('')}</div>`
        : ''
    }
    ${
      searched
        ? `<section class="card dict-result">
            <div class="dict-word">
              <strong>${esc(searched)}</strong>
              ${isEnglish && canSpeak ? `<button type="button" class="btn small" data-action="say" data-text="${esc(searched)}">${ICON.speaker}미국식 발음</button>` : ''}
            </div>
            <div class="dict-links">
              ${Object.entries(DICTIONARIES)
                .map(([key, d]) => `<a class="btn ${key === source ? 'primary' : ''}" href="${esc(d.url(searched))}" target="_blank" rel="noopener">${esc(d.label)}에서 보기${ICON.external}</a>`)
                .join('')}
            </div>
          </section>`
        : `<section class="card empty">
            <p>단어를 검색하면 네이버 · 다음 · Cambridge 영한사전의 최신 내용을 바로 열어 드려요.</p>
          </section>`
    }`;
}

function renderSettings() {
  const hasKey = Boolean(apiKey());
  return `
    <header class="page-head"><h1>설정</h1></header>

    <h2 class="section-title">발음 속도</h2>
    ${segmented('set-rate', RATES.map((r) => [r, `${r}x`]), settings.speechRate, '발음 속도')}
    <button type="button" class="btn wide" data-action="say" data-text="Could we push the meeting back ten minutes?">${ICON.speaker}이 속도로 미리 듣기</button>
    <p class="footnote">더 자연스러운 목소리는 iPhone 설정 &gt; 손쉬운 사용 &gt; 읽기 및 말하기 &gt; 음성 &gt; 영어(미국)에서 '향상된' 음성을 내려받으면 돼요.</p>

    <h2 class="section-title">Claude API 키</h2>
    <form id="key-form" class="card key-form" autocomplete="off">
      ${hasKey ? '<p class="ok">✓ API 키가 저장돼 있어요</p>' : ''}
      <label class="visually-hidden" for="api-key">API 키</label>
      <input id="api-key" type="password" placeholder="${hasKey ? '새 키로 바꾸기' : 'sk-ant-…'}" autocapitalize="off" autocorrect="off" spellcheck="false">
      <div class="row-actions">
        <button type="submit" class="btn primary">저장</button>
        ${hasKey ? '<button type="button" class="btn danger" data-action="delete-key">키 삭제</button>' : ''}
      </div>
      <p class="footnote">상황 표현 찾기에 써요. 같은 사이트의 Talkback에 넣은 키가 있으면 그대로 쓰여요. 키는 이 기기의 브라우저에만 저장돼요.</p>
    </form>

    <h2 class="section-title">홈 화면에 추가하기</h2>
    <section class="card steps">
      <ol>
        <li>iPhone의 Safari로 이 페이지를 열어요.</li>
        <li>아래쪽 공유 버튼을 누르고 <strong>홈 화면에 추가</strong>를 골라요.</li>
      </ol>
    </section>`;
}

const TABS = { situation: renderSituation, dictionary: renderDictionary, settings: renderSettings };

function render() {
  $view.innerHTML = TABS[state.tab]();
  document.querySelectorAll('.tabbar [data-tab]').forEach((button) => {
    button.setAttribute('aria-current', button.dataset.tab === state.tab ? 'page' : 'false');
  });
}

function switchTab(tab) {
  if (!TABS[tab]) return;
  state.tab = tab;
  history.replaceState(null, '', `#${tab}`);
  render();
  window.scrollTo(0, 0);
}

// ---------- Situation finder ----------

async function findPhrases() {
  const sit = state.sit;
  const situation = sit.text.trim();
  if (!situation || sit.loading) return;
  if (!apiKey()) {
    switchTab('settings');
    toast('먼저 Claude API 키를 넣어 주세요');
    return;
  }
  document.activeElement?.blur?.();
  sit.loading = true;
  sit.error = '';
  render();
  try {
    const result = await askJSON({
      key: apiKey(),
      system: 'You help a Korean learner say things the way native English speakers do. Write every Korean field in natural Korean.',
      prompt: `The learner describes a situation in Korean and wants to know what a native English speaker would naturally say.

Situation: ${situation}
Tone: ${TONES[sit.tone].english}

Give 3 natural expressions or short sentences for exactly this situation in that tone. For each:
- en: the English line
- ko: a natural Korean translation
- tip: one short Korean sentence on its nuance or when to use it`,
      schema: PHRASES_SCHEMA,
      effort: 'low',
    });
    sit.phrases = result.phrases;
    sit.searched = situation;
  } catch (error) {
    sit.error = error.message;
  } finally {
    sit.loading = false;
    if (state.tab === 'situation') render();
  }
}

// ---------- Dictionary ----------

function searchDictionary(word) {
  const query = word.trim();
  if (!query) return;
  state.dict.query = query;
  state.dict.searched = query;
  store.set('recentWords', [query, ...store.get('recentWords', []).filter((w) => w !== query)].slice(0, 10));
  window.open(DICTIONARIES[state.dict.source].url(query), '_blank', 'noopener');
  render();
}

// ---------- Events ----------

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('복사했어요');
  } catch {
    toast('복사하지 못했어요. 문장을 길게 눌러 복사해 주세요.');
  }
}

const actions = {
  say: (el) => speak(el.dataset.text, settings.speechRate),
  copy: (el) => copy(el.dataset.text),
  'set-rate': (el) => {
    settings.speechRate = Number(el.dataset.value);
    saveSettings();
    render();
  },
  'delete-key': () => {
    store.remove('apiKey');
    render();
    toast('API 키를 지웠어요');
  },
  'dict-source': (el) => {
    state.dict.source = el.dataset.value;
    store.set('dictSource', state.dict.source);
    render();
  },
  'dict-recent': (el) => searchDictionary(el.dataset.value),
  'sit-tone': (el) => {
    state.sit.tone = el.dataset.value;
    if (state.sit.phrases.length) findPhrases();
    else render();
  },
  'sit-example': (el) => {
    state.sit.text = EXAMPLES[Number(el.dataset.index)];
    render();
  },
  'sit-find': () => findPhrases(),
};

document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-action], [data-tab]');
  if (!el) return;
  if (el.dataset.tab) {
    switchTab(el.dataset.tab);
    return;
  }
  actions[el.dataset.action]?.(el, event);
});

document.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
  if (form.id === 'dict-form') {
    searchDictionary(form.elements.q.value);
  } else if (form.id === 'key-form') {
    const key = document.getElementById('api-key').value.trim();
    if (!key) return;
    store.set('apiKey', key);
    toast('API 키를 저장했어요');
    render();
  }
});

document.addEventListener('input', (event) => {
  if (event.target.id === 'sit-text') state.sit.text = event.target.value;
  if (event.target.id === 'dict-q') state.dict.query = event.target.value;
});

// ---------- Start ----------

const initialTab = location.hash.slice(1);
state.tab = TABS[initialTab] ? initialTab : 'situation';
render();
