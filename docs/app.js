import { askJSON, S } from './claude.js';
import { Conversation } from './conversation.js';
import { Listener, Speaker, canListen } from './speech.js';

// ---------- Storage and settings ----------

const store = {
  get(key, fallback) {
    try {
      const value = localStorage.getItem(`tb.${key}`);
      return value == null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`tb.${key}`, JSON.stringify(value));
    } catch {}
  },
  remove(key) {
    try {
      localStorage.removeItem(`tb.${key}`);
    } catch {}
  },
};

const LEVELS = {
  beginner: {
    label: 'Easy',
    guide: 'Beginner (CEFR A2-B1): short, simple sentences, slow and clear, very common words; no idioms except the target expressions.',
  },
  intermediate: {
    label: 'Mid',
    guide: 'Intermediate (CEFR B1-B2): natural everyday speech with contractions and a few common idioms.',
  },
  advanced: {
    label: 'Hard',
    guide: 'Advanced (CEFR C1): fast, casual native speech with slang, phrasal verbs, idioms and the occasional unexpected question.',
  },
};
const LEVEL_ORDER = ['beginner', 'intermediate', 'advanced'];
const COUNTS = [5, 10, 15, 20];
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
];

const settings = {
  dailyCount: 10,
  speechRate: 0.9,
  level: 'intermediate',
  ...store.get('settings', {}),
};
const saveSettings = () => store.set('settings', settings);
const apiKey = () => store.get('apiKey', '');

function dayKey(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Days in a row with a finished conversation, counting today or yesterday as the latest. */
function streak() {
  const days = new Set(store.get('practiced', []));
  const date = new Date();
  if (!days.has(dayKey(date))) date.setDate(date.getDate() - 1);
  let count = 0;
  while (days.has(dayKey(date))) {
    count += 1;
    date.setDate(date.getDate() - 1);
  }
  return count;
}

function markPracticed() {
  const days = store.get('practiced', []);
  if (!days.includes(dayKey())) store.set('practiced', [...days, dayKey()].slice(-400));
}

// ---------- Claude prompts and schemas ----------

const EXPRESSION_SCHEMA = S.obj({
  phrase: S.str,
  meaningKo: S.str,
  nuanceKo: S.str,
  alternatives: S.arr(S.str),
  example: S.str,
  exampleKo: S.str,
  matchKeywords: S.arr(S.str),
});
const LESSON_SCHEMA = S.obj({
  expressions: S.arr(EXPRESSION_SCHEMA),
  scenario: S.obj({
    title: S.str,
    partnerName: S.str,
    partnerRole: S.str,
    setupKo: S.str,
    setup: S.str,
    openingLine: S.str,
  }),
});
const FEEDBACK_SCHEMA = S.obj({
  good: S.arr(S.str),
  fixes: S.arr(S.obj({ said: S.str, better: S.str, why: S.str })),
  native: S.str,
  nextTip: S.str,
});
const PHRASES_SCHEMA = S.obj({
  phrases: S.arr(S.obj({ en: S.str, ko: S.str, tip: S.str })),
});

function lessonPrompt(taught) {
  const avoid = taught.length ? taught.slice(-150).join('; ') : '(none yet)';
  return `Create today's English lesson.

Learner level: ${LEVELS[settings.level].guide}
Number of expressions: exactly ${settings.dailyCount}

Teach common everyday expressions that native speakers really use in conversation. Do not reuse any of these expressions taught before: ${avoid}

For each expression:
- phrase: the expression itself
- meaningKo: its meaning in Korean
- nuanceKo: the nuance in Korean (when and how natives use it, its tone, any caution), 1-2 sentences
- alternatives: 2-3 other English expressions for similar situations
- example: one natural example sentence
- exampleKo: Korean translation of the example
- matchKeywords: 2-4 short lowercase fragments that would show the learner used this expression or an alternative while speaking (for example "swamped", "slammed", "a lot on my plate")

Then design one role-play scenario where most of these expressions come up naturally:
- title: a short Korean title
- partnerName: an English first name for the partner
- partnerRole: who the partner is to the learner, in English (for example "your coworker")
- setupKo: 1-2 Korean sentences telling the learner the situation and their goal
- setup: the same situation in English, written for the partner
- openingLine: the partner's first spoken line, 1-2 short sentences`;
}

function feedbackPrompt(session) {
  return `Review the learner's lines in this role-play and give feedback.

Learner level: ${LEVELS[settings.level].guide}
Scenario: ${session.scenario.setup}
Target expressions: ${session.expressions.map((e) => e.phrase).join('; ')}

Transcript (the learner's lines come from speech recognition, so ignore punctuation, capitalization and obvious recognition errors):
${session.transcript}

Return:
- good: 1-3 things the learner did well, in Korean, quoting the English they used
- fixes: up to 5 real grammar, word-choice or naturalness problems. said = the learner's original words, better = natural corrected English, why = a short reason in Korean. Return an empty list if there are none.
- native: how a native speaker might have said the learner's key lines, 2-4 sentences of English
- nextTip: one concrete tip for next time, in Korean`;
}

// ---------- App state ----------

const state = {
  tab: 'today',
  lessonLoading: false,
  lessonError: '',
  dict: { query: '', searched: '', source: store.get('dictSource', 'naver') },
  sit: { text: '', tone: 'neutral', phrases: [], searched: '', loading: false, error: '', listening: false },
  feedback: null,
};

const $view = document.getElementById('view');
const $sheet = document.getElementById('sheet');
const $talk = document.getElementById('talk');
const $toast = document.getElementById('toast');

const speaker = new Speaker();
let conversation = null;
let wakeLock = null;
let dictation = null;

function say(text) {
  speaker.rate = settings.speechRate;
  speaker.say(text);
}

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const rateLabel = (rate) => `${rate}x`;

function toast(message) {
  $toast.textContent = message;
  $toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    $toast.hidden = true;
  }, 2200);
}

const ICON = {
  mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  speaker: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  bulb: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.4 1 1.1 1 1.8V16h5v-.3c0-.7.4-1.4 1-1.8A6 6 0 0 0 12 3z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>',
  send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>',
  external: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
};

const speakButton = (text) =>
  `<button type="button" class="icon-btn" data-action="say" data-text="${esc(text)}" aria-label="원어민 발음 듣기">${ICON.speaker}</button>`;

const segmented = (action, options, current, label) => `
  <div class="segmented" role="group" aria-label="${esc(label)}">
    ${options
      .map(
        ([value, text]) =>
          `<button type="button" data-action="${action}" data-value="${esc(value)}" aria-pressed="${String(value) === String(current)}">${esc(text)}</button>`,
      )
      .join('')}
  </div>`;

// ---------- Lesson ----------

function todaysLesson() {
  const lesson = store.get('lesson', null);
  return lesson && lesson.date === dayKey() ? lesson : null;
}

function prepareToday() {
  const lesson = todaysLesson();
  if (lesson && lesson.expressions.length === settings.dailyCount) return;
  if (!apiKey() || state.lessonLoading) return;
  generateLesson();
}

async function generateLesson() {
  if (state.lessonLoading) return;
  state.lessonLoading = true;
  state.lessonError = '';
  if (state.tab === 'today') render();
  try {
    const taught = store.get('taught', []);
    const draft = await askJSON({
      key: apiKey(),
      system: 'You are a friendly English coach for a Korean adult learner. Write every Korean field in natural, conversational Korean.',
      prompt: lessonPrompt(taught),
      schema: LESSON_SCHEMA,
    });
    store.set('lesson', { date: dayKey(), level: settings.level, ...draft });
    store.set('taught', [...taught, ...draft.expressions.map((e) => e.phrase)].slice(-300));
  } catch (error) {
    state.lessonError = error.message;
  } finally {
    state.lessonLoading = false;
    if (state.tab === 'today') render();
  }
}

// ---------- Tabs ----------

function renderToday() {
  const lesson = todaysLesson();
  const days = streak();
  let body = '';
  if (!apiKey()) {
    body = `
      <section class="card notice">
        <h2>시작하려면 Claude API 키가 필요해요</h2>
        <p>설정 탭에서 키를 한 번만 넣으면 매일 새 수업이 만들어져요.</p>
        <button type="button" class="btn primary" data-tab="settings">설정으로 가기</button>
      </section>`;
  } else if (state.lessonLoading) {
    body = `<section class="card loading"><span class="spinner" aria-hidden="true"></span>오늘의 표현과 롤플레이를 만드는 중이에요… (30초쯤 걸려요)</section>`;
  } else if (lesson) {
    const { scenario, expressions } = lesson;
    body = `
      <section class="scenario">
        <span class="eyebrow">오늘의 롤플레이</span>
        <div class="scenario-who">
          <span class="avatar">${esc(scenario.partnerName.slice(0, 1))}</span>
          <div>
            <h2>${esc(scenario.title)}</h2>
            <p>${esc(scenario.setupKo)}</p>
          </div>
        </div>
        <button type="button" class="btn start" data-action="start-talk">${ICON.mic}Start talking</button>
        <span class="hint">마이크 버튼을 누르고 말한 뒤, 다 말하면 다시 누르세요</span>
      </section>
      <section>
        <h2 class="section-title">오늘의 표현 ${expressions.length}개</h2>
        <ul class="list">
          ${expressions
            .map(
              (e, i) => `
            <li><button type="button" class="row" data-action="open-expression" data-index="${i}">
              <strong>${esc(e.phrase)}</strong><span>${esc(e.meaningKo)}</span>
            </button></li>`,
            )
            .join('')}
        </ul>
      </section>`;
  }
  if (state.lessonError) {
    body += `
      <section class="card error">
        <p>${esc(state.lessonError)}</p>
        <button type="button" class="btn" data-action="retry-lesson">다시 시도</button>
      </section>`;
  }
  return `
    <header class="page-head">
      <div>
        <span class="muted">${days > 0 ? `${days}일 연속 연습 중` : '오늘 첫 연습을 시작해 보세요'}</span>
        <h1>Ready to talk?</h1>
      </div>
      <span class="pill">Level · ${LEVELS[settings.level].label}</span>
    </header>
    ${body}`;
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
              ${isEnglish ? `<button type="button" class="btn small" data-action="say" data-text="${esc(searched)}">${ICON.speaker}미국식 발음</button>` : ''}
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

function renderSituation() {
  const sit = state.sit;
  return `
    <header class="page-head">
      <div>
        <span class="muted">상황을 한국어로 말하거나 적어 보세요</span>
        <h1>이럴 땐 영어로?</h1>
      </div>
    </header>
    <section class="card">
      <label class="visually-hidden" for="sit-text">상황 설명</label>
      <textarea id="sit-text" rows="3" placeholder="예: 회의에 10분 늦을 것 같다고 팀장님께 정중하게 말하고 싶어">${esc(sit.text)}</textarea>
      <div class="row-actions">
        ${
          canListen
            ? `<button type="button" class="btn ${sit.listening ? 'recording' : ''}" data-action="sit-mic">${sit.listening ? `${ICON.stop}듣는 중 · 다 말했으면 누르세요` : `${ICON.mic}한국어로 말하기`}</button>`
            : ''
        }
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
                <div class="phrase-head"><strong>${esc(p.en)}</strong>${speakButton(p.en)}</div>
                <span class="muted">${esc(p.ko)}</span>
                <p class="tip">${esc(p.tip)}</p>
              </li>`,
              )
              .join('')}
          </ul>
          <button type="button" class="btn dark wide" data-action="sit-roleplay">${ICON.mic}이 상황으로 롤플레이 연습하기</button>`
        : sit.loading
          ? ''
          : `<h2 class="section-title">예시 상황</h2>
            <ul class="list">
              ${EXAMPLES.map((ex, i) => `<li><button type="button" class="row" data-action="sit-example" data-index="${i}"><span>${esc(ex)}</span></button></li>`).join('')}
            </ul>`
    }`;
}

function renderSettings() {
  const hasKey = Boolean(apiKey());
  return `
    <header class="page-head"><h1>설정</h1></header>

    <h2 class="section-title">하루에 배울 표현 개수</h2>
    ${segmented('set-count', COUNTS.map((n) => [n, `${n}개`]), settings.dailyCount, '하루 표현 개수')}
    <p class="footnote">바꾸면 다음에 '오늘' 탭을 열 때 그 개수로 새 수업을 만들어요.</p>

    <h2 class="section-title">원어민 말하기 속도</h2>
    ${segmented('set-rate', RATES.map((r) => [r, rateLabel(r)]), settings.speechRate, '말하기 속도')}
    <button type="button" class="btn wide" data-action="preview-voice">${ICON.speaker}이 속도로 미리 듣기</button>
    <p class="footnote">대화 중에도 화면 위쪽 속도 버튼으로 바로 바꿀 수 있어요. 더 자연스러운 목소리는 iPhone 설정 &gt; 손쉬운 사용 &gt; 읽기 및 말하기 &gt; 음성 &gt; 영어(미국)에서 '향상된' 음성을 내려받으면 돼요.</p>

    <h2 class="section-title">난이도</h2>
    ${segmented('set-level', LEVEL_ORDER.map((l) => [l, LEVELS[l].label]), settings.level, '난이도')}
    <p class="footnote">대화가 끝난 뒤 피드백 화면에서 고른 답에 따라 자동으로 바뀌어요.</p>

    <h2 class="section-title">매일 연습 알림</h2>
    <section class="card steps">
      <p>웹앱은 스스로 알림을 보낼 수 없어서 iPhone의 <strong>미리 알림</strong> 앱을 써요. 한 번만 만들어 두면 매일 알려 줘요.</p>
      <ol>
        <li>미리 알림 앱에서 새 미리 알림을 만들고 제목을 "Talkback 영어 연습"으로 적어요.</li>
        <li>ⓘ 버튼을 눌러 <strong>날짜</strong>와 <strong>시간</strong>을 켜고 연습할 시간을 골라요.</li>
        <li><strong>반복</strong>을 <strong>매일</strong>로 바꿔요.</li>
      </ol>
      <p class="footnote">알림이 오면 홈 화면의 Talkback 아이콘을 눌러 바로 시작하세요.</p>
    </section>

    <h2 class="section-title">Claude API 키</h2>
    <form id="key-form" class="card key-form" autocomplete="off">
      ${hasKey ? '<p class="ok">✓ API 키가 저장돼 있어요</p>' : ''}
      <label class="visually-hidden" for="api-key">API 키</label>
      <input id="api-key" type="password" placeholder="${hasKey ? '새 키로 바꾸기' : 'sk-ant-…'}" autocapitalize="off" autocorrect="off" spellcheck="false">
      <div class="row-actions">
        <button type="submit" class="btn primary">저장</button>
        ${hasKey ? '<button type="button" class="btn danger" data-action="delete-key">키 삭제</button>' : ''}
      </div>
      <p class="footnote">console.anthropic.com에서 만든 키를 넣어 주세요. 키는 이 기기의 브라우저에만 저장되고, Claude에 요청할 때만 쓰여요.</p>
    </form>

    <h2 class="section-title">홈 화면에 추가하기</h2>
    <section class="card steps">
      <ol>
        <li>iPhone의 Safari로 이 페이지를 열어요.</li>
        <li>아래쪽 공유 버튼을 누르고 <strong>홈 화면에 추가</strong>를 골라요.</li>
      </ol>
      <p class="footnote">홈 화면 아이콘으로 열었을 때 마이크가 안 되면 Safari에서 바로 열어 쓰세요. Safari와 홈 화면 앱은 저장 공간이 따로라서 API 키를 한 번 더 넣어야 해요.</p>
    </section>`;
}

const TABS = { today: renderToday, dictionary: renderDictionary, situation: renderSituation, settings: renderSettings };

function render() {
  $view.innerHTML = TABS[state.tab]();
  document.querySelectorAll('[data-tab]').forEach((button) => {
    if (button.closest('.tabbar')) button.setAttribute('aria-current', button.dataset.tab === state.tab ? 'page' : 'false');
  });
}

function switchTab(tab) {
  if (!TABS[tab]) return;
  if (state.tab === 'situation' && tab !== 'situation') stopDictation();
  state.tab = tab;
  history.replaceState(null, '', `#${tab}`);
  render();
  window.scrollTo(0, 0);
  if (tab === 'today') prepareToday();
}

// ---------- Expression sheet ----------

function openExpression(expression) {
  $sheet.innerHTML = `
    <div class="sheet-backdrop" data-action="close-sheet"></div>
    <div class="sheet-panel" role="dialog" aria-modal="true" aria-label="${esc(expression.phrase)}">
      <div class="sheet-head">
        <h2>${esc(expression.phrase)}</h2>
        ${speakButton(expression.phrase)}
        <button type="button" class="icon-btn" data-action="close-sheet" aria-label="닫기">${ICON.close}</button>
      </div>
      <p class="meaning">${esc(expression.meaningKo)}</p>
      <h3>뉘앙스</h3>
      <p>${esc(expression.nuanceKo)}</p>
      <h3>예문</h3>
      <div class="example">
        <div><strong>${esc(expression.example)}</strong><span class="muted">${esc(expression.exampleKo)}</span></div>
        ${speakButton(expression.example)}
      </div>
      <h3>비슷한 상황에서 쓰는 표현</h3>
      <ul class="alts">
        ${(expression.alternatives || []).map((alt) => `<li><span>${esc(alt)}</span>${speakButton(alt)}</li>`).join('')}
      </ul>
    </div>`;
  $sheet.hidden = false;
}

function closeSheet() {
  $sheet.hidden = true;
  $sheet.innerHTML = '';
}

// ---------- Conversation ----------

async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {}
}

function openTalk(scenario, expressions) {
  if (!apiKey()) {
    switchTab('settings');
    toast('먼저 Claude API 키를 넣어 주세요');
    return;
  }
  speaker.stop();
  stopDictation();
  state.feedback = null;
  conversation = new Conversation({
    scenario,
    expressions,
    level: LEVELS[settings.level].guide,
    rate: settings.speechRate,
    apiKey: apiKey(),
    onChange: updateTalk,
  });
  $talk.className = 'talk';
  $talk.innerHTML = `
    <div class="talk-top">
      <span class="talk-title">${esc(scenario.title)}</span>
      <button type="button" class="pill-btn" data-action="talk-replay" aria-label="상대 말 다시 듣기">${ICON.speaker}</button>
      <button type="button" class="pill-btn" data-action="talk-rate" id="talk-rate" aria-label="원어민 말하기 속도 바꾸기"></button>
      <button type="button" class="pill-btn accent" data-action="talk-hints" id="talk-used"></button>
    </div>
    <div class="talk-partner">
      <span class="avatar big" id="talk-avatar">${esc(scenario.partnerName.slice(0, 1))}</span>
      <strong>${esc(scenario.partnerName)}</strong>
      <span id="talk-status" class="talk-status"></span>
    </div>
    <div class="talk-lines" id="talk-lines" aria-live="polite"></div>
    <p class="talk-error" id="talk-error" hidden></p>
    <div class="talk-hints" id="talk-hints" hidden></div>
    <div class="talk-controls">
      <button type="button" class="round" data-action="talk-hints" aria-label="힌트 보기">${ICON.bulb}</button>
      <button type="button" class="orb" data-action="talk-orb" id="talk-orb">${ICON.mic}</button>
      <button type="button" class="round end" data-action="talk-end" aria-label="대화 끝내기">${ICON.close}</button>
    </div>
    <p class="talk-caption" id="talk-caption"></p>
    <form id="talk-form" class="talk-form" autocomplete="off">
      <label class="visually-hidden" for="talk-input">글자로 답하기</label>
      <input id="talk-input" placeholder="말 대신 글자로 답하기" autocapitalize="off" autocorrect="off" enterkeyhint="send">
      <button type="submit" class="btn small">보내기</button>
    </form>`;
  $talk.hidden = false;
  document.body.classList.add('locked');
  keepAwake(true);
  conversation.start();
  updateTalk();
}

function updateTalk() {
  if (!conversation) return;
  const c = conversation;
  const name = c.scenario.partnerName;
  const mic = c.micState;
  const turn = {
    idle: ['내 차례예요', '마이크 버튼을 누르고 말하세요'],
    recording: ['듣고 있어요 · 천천히 말해도 돼요', '다 말했으면 버튼을 다시 누르세요'],
    finishing: ['보내는 중…', ''],
    paused: c.heard
      ? ['마이크가 꺼졌어요', '버튼을 누르면 지금까지 말한 걸 보내요']
      : ['마이크가 꺼졌어요', '버튼을 누르고 다시 말해 주세요'],
  }[mic];
  const status = {
    idle: '준비 중…',
    listening: turn[0],
    thinking: `${name} 생각 중…`,
    speaking: `${name} 말하는 중`,
  }[c.phase];
  const caption = {
    idle: '',
    listening: turn[1],
    thinking: '버튼을 누르면 상대 말을 끊고 바로 말할 수 있어요',
    speaking: '버튼을 누르면 상대 말을 끊고 바로 말할 수 있어요',
  }[c.phase];
  document.getElementById('talk-status').textContent = status;
  document.getElementById('talk-caption').textContent = caption;
  document.getElementById('talk-rate').textContent = rateLabel(settings.speechRate);
  document.getElementById('talk-used').textContent = `표현 ${c.used.size}/${c.expressions.length}`;
  const orb = document.getElementById('talk-orb');
  const recording = c.phase === 'listening' && (mic === 'recording' || mic === 'finishing');
  const phase = c.phase === 'listening' ? (recording ? 'recording' : 'tap') : c.phase;
  if (orb.dataset.phase !== phase) {
    orb.dataset.phase = phase;
    orb.innerHTML = recording ? ICON.send : ICON.mic;
  }
  orb.setAttribute('aria-label', recording ? '다 말했어요, 보내기' : c.phase === 'listening' ? '마이크 켜고 말하기' : '상대 말 끊고 말하기');
  document.getElementById('talk-avatar').dataset.speaking = String(c.phase === 'speaking');

  const lines = c.lines
    .map((line) => `<p class="bubble ${line.role === 'user' ? 'me' : 'them'}">${esc(line.text || '…')}</p>`)
    .join('');
  const live = c.phase === 'listening' && mic !== 'idle'
    ? `<p class="bubble me live">${esc(c.heard || '…')}</p>`
    : '';
  const $lines = document.getElementById('talk-lines');
  $lines.innerHTML = lines + live;
  $lines.scrollTop = $lines.scrollHeight;

  const $error = document.getElementById('talk-error');
  $error.hidden = !c.error;
  $error.textContent = c.error;

  const $hints = document.getElementById('talk-hints');
  if (!$hints.hidden) $hints.innerHTML = hintsList();
}

function hintsList() {
  return `<ul>${conversation.expressions
    .map((e) => `<li class="${conversation.used.has(e.phrase) ? 'used' : ''}"><strong>${esc(e.phrase)}</strong><span>${esc(e.meaningKo)}</span></li>`)
    .join('')}</ul>`;
}

function finishTalk() {
  const c = conversation;
  const session = {
    transcript: c.transcript,
    scenario: c.scenario,
    expressions: c.expressions,
    used: [...c.used],
    turns: c.learnerTurns,
  };
  c.end();
  conversation = null;
  markPracticed();
  state.feedback = { session, loading: session.turns > 0, error: '', result: null, rated: false };
  renderFeedback();
  if (session.turns > 0) loadFeedback();
}

async function loadFeedback() {
  const fb = state.feedback;
  fb.loading = true;
  fb.error = '';
  renderFeedback();
  try {
    fb.result = await askJSON({
      key: apiKey(),
      system: 'You are an encouraging English speaking coach for a Korean learner. Write every Korean field in natural Korean.',
      prompt: feedbackPrompt(fb.session),
      schema: FEEDBACK_SCHEMA,
    });
  } catch (error) {
    fb.error = error.message;
  } finally {
    fb.loading = false;
    if (state.feedback === fb) renderFeedback();
  }
}

function renderFeedback() {
  const fb = state.feedback;
  const { session, result } = fb;
  const unused = session.expressions.filter((e) => !session.used.includes(e.phrase));
  let body = '';
  if (session.turns === 0) {
    body = '<section class="card"><p>이번 대화에서는 말한 내용이 없어서 피드백을 만들지 않았어요.</p></section>';
  } else if (fb.loading) {
    body = '<section class="card loading"><span class="spinner" aria-hidden="true"></span>피드백을 만드는 중이에요…</section>';
  } else if (fb.error) {
    body = `<section class="card error"><p>${esc(fb.error)}</p><button type="button" class="btn" data-action="feedback-retry">다시 시도</button></section>`;
  } else if (result) {
    body = `
      ${
        result.good.length
          ? `<h2 class="section-title">자연스러웠던 점</h2><ul class="list plain">${result.good.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>`
          : ''
      }
      <h2 class="section-title">고칠 점</h2>
      ${
        result.fixes.length
          ? `<ul class="list fixes">${result.fixes
              .map(
                (f) => `
            <li>
              <s>${esc(f.said)}</s>
              <div class="phrase-head"><strong>${esc(f.better)}</strong>${speakButton(f.better)}</div>
              <span class="muted">${esc(f.why)}</span>
            </li>`,
              )
              .join('')}</ul>`
          : '<section class="card"><p>고칠 부분이 없었어요. 잘했어요!</p></section>'
      }
      <h2 class="section-title">원어민이라면</h2>
      <section class="card native"><p>${esc(result.native)}</p>${speakButton(result.native)}</section>
      <h2 class="section-title">다음 팁</h2>
      <section class="card"><p>${esc(result.nextTip)}</p></section>`;
  }
  $talk.className = 'talk feedback';
  $talk.innerHTML = `
    <div class="feedback-scroll">
      <header class="page-head">
        <div><span class="muted">${esc(session.scenario.title)}</span><h1>피드백</h1></div>
        <button type="button" class="btn primary" data-action="feedback-done">완료</button>
      </header>
      <div class="stats">
        <div><strong>${session.used.length}/${session.expressions.length}</strong><span>사용한 표현</span></div>
        <div><strong>${session.turns}</strong><span>내가 말한 횟수</span></div>
      </div>
      ${body}
      ${
        unused.length
          ? `<h2 class="section-title">다음에 써 볼 표현</h2><ul class="list">${unused
              .map((e) => `<li class="row static"><strong>${esc(e.phrase)}</strong><span>${esc(e.meaningKo)}</span></li>`)
              .join('')}</ul>`
          : ''
      }
      <h2 class="section-title">오늘 난이도는 어땠나요?</h2>
      ${
        fb.rated
          ? `<section class="card"><p>다음 수업은 <strong>${LEVELS[settings.level].label}</strong> 난이도로 만들어요.</p></section>`
          : `<div class="rate">
              <button type="button" class="btn" data-action="rate-level" data-value="1">너무 쉬웠어요</button>
              <button type="button" class="btn" data-action="rate-level" data-value="0">딱 좋아요</button>
              <button type="button" class="btn" data-action="rate-level" data-value="-1">너무 어려웠어요</button>
            </div>`
      }
    </div>`;
}

function closeTalk() {
  conversation?.end();
  conversation = null;
  state.feedback = null;
  $talk.hidden = true;
  $talk.innerHTML = '';
  document.body.classList.remove('locked');
  keepAwake(false);
  render();
}

// ---------- Situation finder ----------

async function findPhrases() {
  const sit = state.sit;
  const situation = sit.text.trim();
  if (!situation || sit.loading) return;
  stopDictation();
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

function toggleDictation() {
  if (state.sit.listening) {
    // Second tap: finish and keep what was heard.
    if (dictation) dictation.finish();
    else stopDictation();
    render();
    return;
  }
  state.sit.error = '';
  dictation = new Listener({
    lang: 'ko-KR',
    onStateChange: () => {
      // The browser closed the mic early: keep what was heard.
      if (dictation?.state === 'paused') dictation.finish();
    },
    onPartial: (text) => {
      state.sit.text = text;
      const box = document.getElementById('sit-text');
      if (box) box.value = text;
    },
    onUtterance: (text) => {
      if (text) state.sit.text = text;
      state.sit.listening = false;
      dictation = null;
      if (state.tab === 'situation') render();
    },
    onError: () => {
      state.sit.listening = false;
      state.sit.error = '마이크를 쓸 수 없어요. 마이크 권한을 허용하거나 키보드의 받아쓰기 버튼을 써 주세요.';
      dictation = null;
      if (state.tab === 'situation') render();
    },
  });
  state.sit.listening = true;
  dictation.start();
  render();
}

function stopDictation() {
  const listener = dictation;
  dictation = null;
  state.sit.listening = false;
  listener?.cancel();
}

function startSituationRolePlay() {
  const sit = state.sit;
  const tone = TONES[sit.tone].english;
  openTalk(
    {
      title: '상황 연습',
      partnerName: 'Alex',
      partnerRole: 'the other person in this situation',
      setupKo: sit.searched,
      setup: `The learner described this situation in Korean: "${sit.searched}". Play the other person in it, speaking in a ${tone} tone. Start the scene so the learner gets to say what they need to say.`,
      openingLine: '',
    },
    sit.phrases.map((p) => ({ phrase: p.en, meaningKo: p.ko, nuanceKo: p.tip, alternatives: [], example: p.en, exampleKo: p.ko, matchKeywords: [] })),
  );
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

const actions = {
  'retry-lesson': () => generateLesson(),
  'start-talk': () => {
    const lesson = todaysLesson();
    if (lesson) openTalk(lesson.scenario, lesson.expressions);
  },
  'open-expression': (el) => {
    const lesson = todaysLesson();
    const expression = lesson?.expressions[Number(el.dataset.index)];
    if (expression) openExpression(expression);
  },
  'close-sheet': () => closeSheet(),
  say: (el) => say(el.dataset.text),

  'set-count': (el) => {
    settings.dailyCount = Number(el.dataset.value);
    saveSettings();
    render();
  },
  'set-rate': (el) => {
    settings.speechRate = Number(el.dataset.value);
    saveSettings();
    render();
  },
  'set-level': (el) => {
    settings.level = el.dataset.value;
    saveSettings();
    render();
  },
  'preview-voice': () => say('Hey! Did you get a chance to send me that report?'),
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
  'sit-mic': () => toggleDictation(),
  'sit-find': () => findPhrases(),
  'sit-roleplay': () => startSituationRolePlay(),

  'talk-orb': () => {
    if (!conversation) return;
    conversation.tap();
  },
  'talk-replay': () => conversation?.replayLast(),
  'talk-end': () => finishTalk(),
  'talk-rate': () => {
    const next = RATES[(RATES.indexOf(settings.speechRate) + 1) % RATES.length];
    settings.speechRate = next;
    saveSettings();
    conversation?.setRate(next);
    updateTalk();
  },
  'talk-hints': () => {
    const $hints = document.getElementById('talk-hints');
    $hints.hidden = !$hints.hidden;
    if (!$hints.hidden) $hints.innerHTML = hintsList();
  },
  'rate-level': (el) => {
    const step = Number(el.dataset.value);
    const index = Math.max(0, Math.min(LEVEL_ORDER.length - 1, LEVEL_ORDER.indexOf(settings.level) + step));
    settings.level = LEVEL_ORDER[index];
    saveSettings();
    state.feedback.rated = true;
    renderFeedback();
  },
  'feedback-retry': () => loadFeedback(),
  'feedback-done': () => closeTalk(),
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
  } else if (form.id === 'talk-form') {
    const input = document.getElementById('talk-input');
    conversation?.sendTyped(input.value);
    input.value = '';
  }
});

document.addEventListener('input', (event) => {
  if (event.target.id === 'sit-text') state.sit.text = event.target.value;
  if (event.target.id === 'dict-q') state.dict.query = event.target.value;
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$sheet.hidden) closeSheet();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && conversation) keepAwake(true);
});

// ---------- Start ----------

const initialTab = location.hash.slice(1);
state.tab = TABS[initialTab] ? initialTab : 'today';
render();
if (state.tab === 'today') prepareToday();
