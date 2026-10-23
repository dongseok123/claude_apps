// Speech in and out, using the browser's built-in recognition and voices.
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
export const canListen = Boolean(Recognition);
export const canSpeak = 'speechSynthesis' in window;

/**
 * Listens for one utterance and reports it after a short pause.
 * Call start() again for the next one.
 */
export class Listener {
  constructor({ lang = 'en-US', silenceMs = 1300, onPartial, onUtterance, onError }) {
    Object.assign(this, { lang, silenceMs, onPartial, onUtterance, onError });
    this.active = false;
    this.recognition = null;
    this.text = '';
    this.timer = null;
  }

  start() {
    if (!canListen) {
      this.onError?.('unsupported');
      return;
    }
    this.active = true;
    this.begin();
  }

  stop() {
    this.active = false;
    clearTimeout(this.timer);
    this.text = '';
    this.release();
  }

  begin() {
    if (!this.active) return;
    const recognition = new Recognition();
    recognition.lang = this.lang;
    recognition.continuous = true;
    recognition.interimResults = true;
    this.recognition = recognition;
    this.text = '';

    recognition.onresult = (event) => {
      let text = '';
      for (let i = 0; i < event.results.length; i += 1) text += event.results[i][0].transcript;
      text = text.trim();
      if (!text || text === this.text) return;
      this.text = text;
      this.onPartial?.(text);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.finish(), this.silenceMs);
    };
    recognition.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        this.active = false;
        this.onError?.('not-allowed');
      }
    };
    recognition.onend = () => {
      if (this.recognition !== recognition) return;
      // The browser ends recognition after a stretch of silence; keep listening.
      if (this.text) this.finish();
      else if (this.active) setTimeout(() => this.begin(), 250);
    };
    try {
      recognition.start();
    } catch {
      this.onError?.('start-failed');
    }
  }

  finish() {
    clearTimeout(this.timer);
    const text = this.text.trim();
    this.text = '';
    this.active = false;
    this.release();
    if (text) this.onUtterance?.(text);
  }

  release() {
    const recognition = this.recognition;
    this.recognition = null;
    if (!recognition) return;
    recognition.onresult = null;
    recognition.onend = null;
    recognition.onerror = null;
    try {
      recognition.abort();
    } catch {}
  }
}

let chosenVoice = null;

function pickVoice() {
  if (chosenVoice || !canSpeak) return chosenVoice;
  const voices = speechSynthesis.getVoices().filter((voice) => /^en[-_]US$/i.test(voice.lang));
  const rank = (voice) => {
    if (/premium/i.test(voice.name)) return 0;
    if (/enhanced/i.test(voice.name)) return 1;
    if (/^(ava|samantha|zoe|evan|nathan|allison|susan|tom)/i.test(voice.name)) return 2;
    if (voice.localService) return 3;
    return 4;
  };
  chosenVoice = voices.sort((a, b) => rank(a) - rank(b))[0] || null;
  return chosenVoice;
}

if (canSpeak) {
  speechSynthesis.addEventListener?.('voiceschanged', () => {
    chosenVoice = null;
  });
}

/** Reads English aloud, one queued sentence after another. */
export class Speaker {
  constructor() {
    this.rate = 0.9;
    this.pending = 0;
    this.generation = 0;
    this.onDone = null;
  }

  get speaking() {
    return this.pending > 0;
  }

  /** Call from a tap so iOS allows speech that starts later without one. */
  unlock() {
    if (!canSpeak) return;
    const silent = new SpeechSynthesisUtterance(' ');
    silent.volume = 0;
    speechSynthesis.speak(silent);
  }

  say(text) {
    this.stop();
    this.enqueue(text);
  }

  enqueue(text) {
    const clean = String(text || '').trim();
    if (!clean || !canSpeak) return;
    const generation = this.generation;
    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.lang = 'en-US';
    const voice = pickVoice();
    if (voice) utterance.voice = voice;
    utterance.rate = this.rate;
    let finished = false;
    const done = () => {
      if (finished || generation !== this.generation) return;
      finished = true;
      this.pending = Math.max(0, this.pending - 1);
      if (this.pending === 0) this.onDone?.();
    };
    utterance.onend = done;
    utterance.onerror = done;
    this.pending += 1;
    speechSynthesis.speak(utterance);
  }

  stop() {
    this.generation += 1;
    this.pending = 0;
    if (canSpeak) speechSynthesis.cancel();
  }
}
