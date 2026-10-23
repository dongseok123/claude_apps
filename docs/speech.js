// Speech in and out, using the browser's built-in recognition and voices.
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
export const canListen = Boolean(Recognition);
export const canSpeak = 'speechSynthesis' in window;

/**
 * Listens for one utterance and reports it after a short pause.
 * Call start() again for the next one.
 *
 * iOS Safari stops hearing anything if a recognition session is aborted and a new
 * one started right away, so this keeps one recognizer, ends each session with
 * stop(), and only starts the next session after the previous one has ended.
 */
export class Listener {
  constructor({ lang = 'en-US', silenceMs = 1300, onPartial, onUtterance, onError, onStateChange }) {
    Object.assign(this, { lang, silenceMs, onPartial, onUtterance, onError, onStateChange });
    this.active = false; // we want to hear the learner
    this.running = false; // a browser session is open
    this.recognition = null;
    this.text = '';
    this.silenceTimer = null;
    this.startTimer = null;
  }

  /** True when the microphone is actually open and waiting for speech. */
  get hearing() {
    return this.active && this.running;
  }

  start() {
    if (!canListen) {
      this.onError?.('unsupported');
      return;
    }
    this.active = true;
    this.text = '';
    this.schedule(300);
  }

  /** Reopens the microphone; call from a tap, which iOS trusts most. */
  restart() {
    if (!canListen) return;
    this.active = true;
    this.text = '';
    clearTimeout(this.silenceTimer);
    if (this.running) {
      this.endSession();
    } else {
      clearTimeout(this.startTimer);
      this.open();
    }
  }

  stop() {
    this.active = false;
    this.text = '';
    clearTimeout(this.silenceTimer);
    clearTimeout(this.startTimer);
    this.endSession();
    this.onStateChange?.();
  }

  recognizer() {
    if (this.recognition) return this.recognition;
    const recognition = new Recognition();
    recognition.lang = this.lang;
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onstart = () => {
      this.running = true;
      this.onStateChange?.();
    };
    recognition.onresult = (event) => {
      if (!this.active) return;
      let text = '';
      for (let i = 0; i < event.results.length; i += 1) text += event.results[i][0].transcript;
      text = text.trim();
      if (!text || text === this.text) return;
      this.text = text;
      this.onPartial?.(text);
      clearTimeout(this.silenceTimer);
      this.silenceTimer = setTimeout(() => this.finish(), this.silenceMs);
    };
    recognition.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        this.active = false;
        this.onError?.('not-allowed');
      }
      // Other errors (no-speech, aborted, network) end the session; onend restarts it.
    };
    recognition.onend = () => {
      this.running = false;
      this.onStateChange?.();
      if (!this.active) return;
      // iOS often ends the session at a pause; treat what was heard as finished.
      if (this.text) this.finish();
      else this.schedule(300);
    };
    this.recognition = recognition;
    return recognition;
  }

  schedule(delay) {
    clearTimeout(this.startTimer);
    this.startTimer = setTimeout(() => this.open(), delay);
  }

  open() {
    if (!this.active || this.running) return;
    try {
      this.recognizer().start();
      this.running = true;
    } catch {
      // Still closing the last session; try again shortly.
      this.schedule(400);
    }
  }

  endSession() {
    if (!this.running || !this.recognition) return;
    try {
      this.recognition.stop();
    } catch {}
  }

  finish() {
    clearTimeout(this.silenceTimer);
    const text = this.text.trim();
    this.text = '';
    this.active = false;
    this.endSession();
    this.onStateChange?.();
    if (text) this.onUtterance?.(text);
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
