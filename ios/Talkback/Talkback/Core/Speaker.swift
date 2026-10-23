import AVFoundation
import Combine

/// Reads English aloud in the best US voice installed on the phone.
@MainActor
final class Speaker: NSObject, ObservableObject {
    @Published private(set) var isSpeaking = false
    /// 1.0 is a natural native pace.
    var rate = 0.9
    /// Called once everything queued has been spoken.
    var onFinished: (() -> Void)?
    /// What is queued or being spoken, used to tell our own voice apart from the learner's.
    private(set) var recentText = ""

    private let synthesizer = AVSpeechSynthesizer()
    private let voice = Speaker.bestVoice()
    private var pending = 0

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    nonisolated static func bestVoice() -> AVSpeechSynthesisVoice? {
        let voices = AVSpeechSynthesisVoice.speechVoices().filter {
            $0.language == "en-US" && !$0.voiceTraits.contains(.isNoveltyVoice)
        }
        return voices.max { $0.quality.rawValue < $1.quality.rawValue } ?? AVSpeechSynthesisVoice(language: "en-US")
    }

    /// Stops anything playing and says `text`.
    func say(_ text: String) {
        stop()
        enqueue(text)
    }

    /// Adds `text` after whatever is already queued.
    func enqueue(_ text: String) {
        let clean = text.trimmed
        guard !clean.isEmpty else { return }
        AudioSession.activateForPlayback()
        let utterance = AVSpeechUtterance(string: clean)
        utterance.voice = voice
        utterance.rate = Float(Double(AVSpeechUtteranceDefaultSpeechRate) * rate)
        pending += 1
        isSpeaking = true
        recentText += " " + clean
        synthesizer.speak(utterance)
    }

    func stop() {
        pending = 0
        isSpeaking = false
        recentText = ""
        synthesizer.stopSpeaking(at: .immediate)
    }

    fileprivate func utteranceFinished() {
        guard pending > 0 else { return }
        pending -= 1
        guard pending == 0 else { return }
        isSpeaking = false
        recentText = ""
        onFinished?()
    }
}

extension Speaker: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in self.utteranceFinished() }
    }
}
