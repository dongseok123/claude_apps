// Minimal Claude Messages API client for the browser.
const API = 'https://api.anthropic.com/v1/messages';

export const MODELS = {
  // Model for phrase suggestions.
  coach: 'claude-opus-5-5',
};

export const S = {
  str: { type: 'string' },
  arr: (items) => ({ type: 'array', items }),
  obj: (properties) => ({
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  }),
};

export class ClaudeError extends Error {}

function friendly(status, message) {
  switch (status) {
    case 401: return 'API 키가 올바르지 않아요. 설정 탭에서 키를 다시 확인해 주세요.';
    case 429: return '요청이 많아 잠시 기다려야 해요. 조금 뒤에 다시 시도해 주세요.';
    case 529: return 'Claude가 지금 붐벼요. 잠시 뒤에 다시 시도해 주세요.';
    default: return `Claude 요청이 실패했어요 (${status}). ${message || ''}`.trim();
  }
}

function makeRequest(key, model, body, signal) {
  if (!key) throw new ClaudeError('설정 탭에서 Claude API 키를 먼저 입력해 주세요.');
  const headers = {
    'content-type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2026-10-21',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  const payload = { ...body, model };
  // If a safety check declines a request, let the API retry it on its recommended fallback model.
  if (/^claude-(opus|fable|sonnet-5-5)/.test(model)) {
    payload.fallbacks = 'default';
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  }
  return fetch(API, { method: 'POST', headers, body: JSON.stringify(payload), signal });
}

async function errorFrom(response) {
  let message = '';
  try {
    message = (await response.json())?.error?.message || '';
  } catch {}
  return new ClaudeError(friendly(response.status, message));
}

function networkError(error) {
  if (error.name === 'AbortError') return error;
  if (error instanceof ClaudeError) return error;
  return new ClaudeError('인터넷 연결을 확인해 주세요.');
}

/** Asks for an answer shaped by `schema` and returns it parsed. */
export async function askJSON({ key, model = MODELS.coach, system, prompt, schema, effort = 'medium', maxTokens = 16000 }) {
  let response;
  try {
    response = await makeRequest(key, model, {
      max_tokens: maxTokens,
      system,
      output_config: { effort, format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (error) {
    throw networkError(error);
  }
  if (!response.ok) throw await errorFrom(response);
  const message = await response.json();
  if (message.stop_reason === 'refusal') {
    throw new ClaudeError('Claude가 이 요청에는 답하지 않았어요. 표현을 바꿔서 다시 시도해 주세요.');
  }
  // Read only text blocks: the reply can also carry thinking or fallback blocks.
  const text = (message.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('');
  try {
    return JSON.parse(text);
  } catch {
    throw new ClaudeError('Claude의 답을 읽지 못했어요. 다시 시도해 주세요.');
  }
}
