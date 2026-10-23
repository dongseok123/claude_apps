// Reads English aloud with the best US voice on the device.
export const canSpeak = 'speechSynthesis' in window;

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

export function speak(text, rate = 0.9) {
  const clean = String(text || '').trim();
  if (!clean || !canSpeak) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(clean);
  utterance.lang = 'en-US';
  const voice = pickVoice();
  if (voice) utterance.voice = voice;
  utterance.rate = rate;
  speechSynthesis.speak(utterance);
}
