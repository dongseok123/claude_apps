// Speech in and out, using the browser's built-in recognition and voices.
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
export const canListen = Boolean(Recognition);
export const canSpeak = 'speechSynthesis' in window;

/**
 * Push-to-talk: start() opens the mic (call it from a tap), finish() closes it
 * and reports everything heard (also from a tap). Nothing is sent on a pause.
 *
 * iPhone Safari only gives a recognizer audio when it is started from a tap,
 * and may close the mic by itself after a while; then the state becomes
 * 'paused' and what was heard so far is kept for finish().
 */
export class Listener {
  constructor({ lang = 'en-US', onPartial, onUtterance, onError, onStateChange }) {
    Object.assign(this, { lang, onPartial, onUtterance, onError, onStateChange });
    this.state = 'idle'; // idle | recording | finishing | paused
    this.session = null;
    this.saved = ''; // heard in sessions the browser already closed
    this.current = ''; // heard in the open session
    this.finishTimer = null;
  }

  get text() {
    return [this.saved, this.current].filter(Boolean).join(' ').trim();
  }

  /** Opens the mic. Call from a tap. */
  start() {
    if (!canListen) {
      this.onError?.('unsupported');
      return;
    }
    this.cancel();
    this.state = 'recording';
    this.open();
    this.onStateChange?.();
  }

  /** Closes the mic and reports what was heard. Call from a tap. */
  finish() {
    if (this.state === 'finishing' || this.state === 'idle') return;
    if (!this.session) {
      this.deliver();
      return;
    }
    this.state = 'finishing';
    this.onStateChange?.();
    // stop() lets the recognizer hand over its last words before it ends.
    try {
      this.session.recognition.stop();
    } catch {}
    clearTimeout(this.finishTimer);
    // iOS does not always report the end, so don't wait for it for long.
    this.finishTimer = setTimeout(() => {
      if (this.state === 'finishing') this.deliver();
    }, 1500);
  }

  /** Turns the mic off and throws away what was heard. */
  cancel() {
    clearTimeout(this.finishTimer);
    const session = this.session;
    this.session = null;
    this.state = 'idle';
    this.saved = '';
    this.current = '';
    if (session) {
      try {
        session.recognition.stop();
      } catch {}
    }
  }

  open() {
    const recognition = new Recognition();
    recognition.lang = this.lang;
    recognition.continuous = true;
    recognition.interimResults = true;
    const session = { recognition };
    this.session = session;
    const current = () => this.session === session;

    recognition.onresult = (event) => {
      if (!current()) return;
      let text = '';
      for (let i = 0; i < event.results.length; i += 1) text += event.results[i][0].transcript;
      this.current = text.trim();
      this.onPartial?.(this.text);
    };
    recognition.onerror = (event) => {
      if (!current()) return;
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        this.cancel();
        this.onStateChange?.();
        this.onError?.('not-allowed');
      }
      // Other errors end the session; onend handles it.
    };
    recognition.onend = () => {
      if (!current()) return;
      this.session = null;
      this.saved = this.text;
      this.current = '';
      if (this.state === 'finishing') {
        this.deliver();
      } else if (this.state === 'recording') {
        // The browser closed the mic before the learner tapped to finish.
        this.state = 'paused';
        this.onStateChange?.();
      }
    };

    try {
      recognition.start();
    } catch {
      this.session = null;
      this.state = 'paused';
    }
  }

  deliver() {
    clearTimeout(this.finishTimer);
    const text = this.text;
    this.cancel();
    this.onStateChange?.();
    this.onUtterance?.(text);
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
