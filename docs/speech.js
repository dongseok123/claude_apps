// Speech in and out, using the browser's built-in recognition and voices.
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
export const canListen = Boolean(Recognition);
export const canSpeak = 'speechSynthesis' in window;

/**
 * Listens for one utterance and reports it after a short pause.
 * Call start() again for the next one.
 *
 * iOS Safari's recognizer is unreliable between turns: sessions can stop hearing,
 * and it does not always report that a session ended. So every turn gets a fresh
 * recognizer, nothing ever waits for an "ended" event, a session that never
 * starts is replaced, and after repeated failures the listener asks for a tap
 * (iOS trusts a session started from a tap the most).
 */
export class Listener {
  /**
   * autoReopen: reopen the mic by itself after a quiet stretch or a failed start.
   * iPhone Safari only lets a tap open the mic, so it is off there.
   */
  constructor({ lang = 'en-US', silenceMs = 1300, autoReopen = true, onPartial, onUtterance, onError, onStateChange }) {
    Object.assign(this, { lang, silenceMs, autoReopen, onPartial, onUtterance, onError, onStateChange });
    this.active = false; // we want to hear the learner
    this.session = null; // { recognition, started }
    this.text = '';
    this.failures = 0;
    this.needsTap = false;
    this.silenceTimer = null;
    this.startTimer = null;
    this.watchdog = null;
  }

  /** True when the microphone is actually open and waiting for speech. */
  get hearing() {
    return this.active && Boolean(this.session?.started);
  }

  /** Opens the microphone. Pass fromTap when called inside a tap handler. */
  start({ fromTap = false } = {}) {
    if (!canListen) {
      this.onError?.('unsupported');
      return;
    }
    this.active = true;
    this.needsTap = false;
    this.failures = 0;
    this.text = '';
    clearTimeout(this.silenceTimer);
    this.closeSession();
    if (fromTap) this.openSession();
    else this.openLater(500);
  }

  stop() {
    this.active = false;
    this.text = '';
    clearTimeout(this.silenceTimer);
    clearTimeout(this.startTimer);
    this.closeSession();
    this.onStateChange?.();
  }

  openLater(delay) {
    clearTimeout(this.startTimer);
    this.startTimer = setTimeout(() => this.openSession(), delay);
  }

  openSession() {
    if (!this.active) return;
    const recognition = new Recognition();
    recognition.lang = this.lang;
    recognition.continuous = false;
    recognition.interimResults = true;
    const session = { recognition, started: false };
    this.session = session;
    const current = () => this.session === session;

    recognition.onstart = () => {
      if (!current()) return;
      session.started = true;
      this.failures = 0;
      this.onStateChange?.();
    };
    recognition.onresult = (event) => {
      if (!current() || !this.active) return;
      let text = '';
      for (let i = 0; i < event.results.length; i += 1) text += event.results[i][0].transcript;
      text = text.trim();
      if (!text || text === this.text) return;
      session.started = true;
      this.text = text;
      this.onPartial?.(text);
      clearTimeout(this.silenceTimer);
      this.silenceTimer = setTimeout(() => this.finish(), this.silenceMs);
    };
    recognition.onerror = (event) => {
      if (!current()) return;
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        this.active = false;
        this.closeSession();
        this.onError?.('not-allowed');
      }
      // Other errors (no-speech, aborted, network) also end the session; onend handles it.
    };
    recognition.onend = () => {
      if (!current()) return;
      const started = session.started;
      this.session = null;
      clearTimeout(this.watchdog);
      this.onStateChange?.();
      if (!this.active) return;
      if (this.text) this.finish();
      else if (started && this.autoReopen) this.openLater(300); // a quiet stretch; keep listening
      else this.failed();
    };

    try {
      recognition.start();
    } catch {
      this.session = null;
      this.failed();
      return;
    }
    // A session that never starts is stuck; replace it instead of waiting.
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      if (current() && !session.started) {
        this.closeSession();
        this.failed();
      }
    }, 2500);
    this.onStateChange?.();
  }

  failed() {
    this.failures += 1;
    if (!this.autoReopen || this.failures >= 3) {
      // Ask for a tap rather than retrying forever.
      this.needsTap = true;
      this.onStateChange?.();
      return;
    }
    this.openLater(600);
  }

  closeSession() {
    clearTimeout(this.watchdog);
    const session = this.session;
    this.session = null;
    if (!session) return;
    try {
      session.recognition.stop();
    } catch {}
  }

  finish() {
    clearTimeout(this.silenceTimer);
    const text = this.text.trim();
    this.text = '';
    this.active = false;
    this.closeSession();
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
