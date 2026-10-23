import { streamText } from './claude.js';
import { Listener, Speaker } from './speech.js';

const SENTENCE_END = /[.!?]["')\]]*\s+/;

export const normalize = (text) => String(text).toLowerCase().replace(/[’‘]/g, "'");

/**
 * A spoken role-play: listen until the learner pauses, ask Claude,
 * read the reply sentence by sentence, then listen again.
 * The microphone is off while the partner talks (so it never hears itself);
 * tapping the orb cuts the partner off.
 * handsFree reopens the mic by itself after each reply; without it (iPhone Safari,
 * which only lets a tap open the mic) the learner taps the orb once per turn.
 */
export class Conversation {
  constructor({ scenario, expressions, level, rate, apiKey, handsFree, onChange }) {
    Object.assign(this, { scenario, expressions, level, apiKey, handsFree, onChange });
    this.phase = 'idle';
    this.lines = [];
    this.heard = '';
    this.used = new Set();
    this.error = '';
    this.history = [];
    this.controller = null;
    this.currentReply = '';
    this.committed = true;
    this.streamDone = true;

    this.speaker = new Speaker();
    this.speaker.rate = rate;
    this.speaker.onDone = () => this.speakerDone();
    this.listener = new Listener({
      lang: 'en-US',
      autoReopen: handsFree,
      onPartial: (text) => {
        this.heard = text;
        this.emit();
      },
      onUtterance: (text) => this.learnerSaid(text),
      onError: (code) => this.micFailed(code),
      onStateChange: () => this.emit(),
    });
  }

  get learnerTurns() {
    return this.lines.filter((line) => line.role === 'user').length;
  }

  get transcript() {
    return this.lines
      .map((line) => `${line.role === 'user' ? 'Learner' : this.scenario.partnerName}: ${line.text}`)
      .join('\n');
  }

  emit() {
    this.onChange?.();
  }

  /** Call from the tap that opens the conversation. */
  start() {
    this.speaker.unlock();
    this.history = [{ role: 'user', content: '(The role-play begins. Say your opening line.)' }];
    const opening = String(this.scenario.openingLine || '').trim();
    if (!opening) {
      this.respond();
      return;
    }
    this.history.push({ role: 'assistant', content: opening });
    this.lines = [{ role: 'assistant', text: opening }];
    this.streamDone = true;
    this.committed = true;
    this.phase = 'speaking';
    this.speaker.enqueue(opening);
    this.emit();
  }

  end() {
    this.controller?.abort();
    this.speaker.onDone = null;
    this.speaker.stop();
    this.listener.stop();
    this.phase = 'idle';
  }

  setRate(rate) {
    this.speaker.rate = rate;
  }

  /** Cuts the partner off so the learner can talk. */
  interrupt({ fromTap = false } = {}) {
    if (this.phase !== 'speaking' && this.phase !== 'thinking') return;
    this.controller?.abort();
    this.streamDone = true;
    this.speaker.stop();
    this.commit();
    this.lines = this.lines.filter((line) => line.role === 'user' || line.text);
    this.listen({ fromTap });
  }

  /**
   * The orb: cuts the partner off and opens the mic, opens the mic when it is
   * closed, or sends what was heard right away. Call from a tap.
   */
  tap() {
    if (this.phase === 'speaking' || this.phase === 'thinking') {
      this.interrupt({ fromTap: true });
    } else if (this.phase === 'listening') {
      if (this.listener.hearing && this.listener.text) {
        this.listener.finish();
      } else {
        this.heard = '';
        this.error = '';
        this.listener.start({ fromTap: true });
        this.emit();
      }
    }
  }

  /** True when the microphone is open and waiting for the learner. */
  get micReady() {
    return this.phase === 'listening' && this.listener.hearing;
  }

  /** True when the learner's turn is waiting for a tap to open the mic. */
  get micNeedsTap() {
    return this.phase === 'listening' && (!this.listener.active || this.listener.needsTap);
  }

  replayLast() {
    if (this.phase !== 'listening') return;
    const last = [...this.lines].reverse().find((line) => line.role === 'assistant');
    if (!last) return;
    this.listener.stop();
    this.heard = '';
    this.streamDone = true;
    this.phase = 'speaking';
    this.speaker.enqueue(last.text);
    this.emit();
  }

  /** Typed input, for when the microphone is unavailable or misheard. */
  sendTyped(text) {
    const clean = text.trim();
    if (!clean) return;
    if (this.phase === 'speaking' || this.phase === 'thinking') this.interrupt();
    this.listener.stop();
    this.phase = 'listening';
    this.learnerSaid(clean);
  }

  listen({ fromTap = false } = {}) {
    this.heard = '';
    this.phase = 'listening';
    if (this.handsFree || fromTap) this.listener.start({ fromTap });
    else this.listener.stop();
    this.emit();
  }

  learnerSaid(text) {
    if (this.phase !== 'listening') return;
    this.heard = '';
    this.lines.push({ role: 'user', text });
    this.history.push({ role: 'user', content: text });
    this.track(text);
    this.respond();
  }

  respond() {
    this.phase = 'thinking';
    this.streamDone = false;
    this.committed = false;
    this.currentReply = '';
    const line = { role: 'assistant', text: '' };
    this.lines.push(line);
    this.emit();

    const controller = new AbortController();
    this.controller = controller;
    (async () => {
      let buffer = '';
      try {
        for await (const chunk of streamText({
          key: this.apiKey,
          system: this.systemPrompt(),
          messages: this.recentHistory(),
          signal: controller.signal,
        })) {
          if (controller.signal.aborted) return;
          this.currentReply += chunk;
          line.text = this.currentReply;
          buffer += chunk;
          let match;
          while ((match = SENTENCE_END.exec(buffer))) {
            const cut = match.index + match[0].length;
            this.say(buffer.slice(0, cut));
            buffer = buffer.slice(cut);
          }
          this.emit();
        }
        if (controller.signal.aborted) return;
        this.say(buffer);
        this.streamDone = true;
        if (!this.speaker.speaking) this.speakerDone();
      } catch (error) {
        if (controller.signal.aborted) return;
        this.error = error.message;
        this.lines = this.lines.filter((entry) => entry !== line || entry.text);
        this.streamDone = true;
        this.speaker.stop();
        this.commit();
        this.listen();
      }
    })();
  }

  say(sentence) {
    if (!sentence.trim()) return;
    if (this.phase === 'thinking') {
      this.phase = 'speaking';
      this.emit();
    }
    this.speaker.enqueue(sentence);
  }

  speakerDone() {
    if ((this.phase !== 'speaking' && this.phase !== 'thinking') || !this.streamDone) return;
    this.commit();
    this.listen();
  }

  commit() {
    if (this.committed) return;
    this.committed = true;
    const text = this.currentReply.trim();
    if (text) this.history.push({ role: 'assistant', content: text });
  }

  micFailed(code) {
    this.error = code === 'unsupported'
      ? '이 브라우저는 음성 인식을 지원하지 않아요. iPhone의 Safari로 열어 주세요. 아래 입력칸에 글자로 답할 수도 있어요.'
      : '마이크를 쓸 수 없어요. 마이크 권한을 허용하고 다시 시작해 주세요. 아래 입력칸에 글자로 답할 수도 있어요.';
    this.emit();
  }

  /** The last 40 turns, starting on a learner turn as the API requires. */
  recentHistory() {
    const slice = this.history.slice(-40);
    while (slice.length && slice[0].role === 'assistant') slice.shift();
    return slice;
  }

  track(text) {
    const said = normalize(text);
    for (const expression of this.expressions) {
      const keys = [expression.phrase, ...(expression.matchKeywords || [])].map(normalize).filter(Boolean);
      if (keys.some((key) => said.includes(key))) this.used.add(expression.phrase);
    }
  }

  systemPrompt() {
    const { partnerName, partnerRole, setup } = this.scenario;
    const targets = this.expressions.map((expression) => expression.phrase).join('; ');
    return `You are role-playing as ${partnerName}, ${partnerRole}, in a spoken English conversation practice with a Korean learner.
Scenario: ${setup}
Learner level: ${this.level}
Target expressions the learner is practicing: ${targets}

Rules:
- Stay in character. Reply with only what ${partnerName} says out loud: 1-3 short sentences of natural spoken English with contractions. No stage directions, emoji, markdown or lists.
- Your words are turned into speech, so write them the way they are said.
- Don't correct the learner's mistakes during the role-play; react the way a real person would.
- Create natural chances for the learner to use the target expressions, without naming them.
- The learner's words come from speech recognition and may contain small recognition errors; read them generously.
- If the learner seems stuck or speaks Korean, rephrase your last line more simply in English.
- After about 10 exchanges, start wrapping up the conversation naturally.`;
  }
}
