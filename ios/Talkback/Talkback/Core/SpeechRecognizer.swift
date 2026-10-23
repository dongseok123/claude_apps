import AVFoundation
import Combine
import Speech

/// Listens continuously and reports each utterance once the speaker pauses.
@MainActor
final class SpeechRecognizer: ObservableObject {
    enum RecognizerError: LocalizedError {
        case notAuthorized
        case unavailable

        var errorDescription: String? {
            switch self {
            case .notAuthorized:
                return "마이크와 음성 인식 권한이 필요해요. 설정 앱 > Talkback에서 허용해 주세요."
            case .unavailable:
                return "지금은 음성 인식을 쓸 수 없어요. 인터넷 연결을 확인해 주세요."
            }
        }
    }

    @Published private(set) var transcript = ""
    @Published private(set) var isRunning = false

    /// Every change in what has been heard so far.
    var onPartial: ((String) -> Void)?
    /// A finished utterance, after `silenceTimeout` seconds without new words.
    var onUtterance: ((String) -> Void)?
    var silenceTimeout: TimeInterval = 1.2

    private let recognizer: SFSpeechRecognizer?
    private let engine = AVAudioEngine()
    private let requestBox = RequestBox()
    private var task: SFSpeechRecognitionTask?
    private var generation = 0
    private var silenceTimer: Timer?

    init(locale: Locale = Locale(identifier: "en-US")) {
        recognizer = SFSpeechRecognizer(locale: locale)
    }

    nonisolated static func requestPermissions() async -> Bool {
        let speech = await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
        }
        guard speech else { return false }
        return await AVAudioApplication.requestRecordPermission()
    }

    func start() throws {
        guard !isRunning else { return }
        guard let recognizer, recognizer.isAvailable else { throw RecognizerError.unavailable }
        try AudioSession.activateForConversation()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0 else { throw RecognizerError.unavailable }
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format, block: Self.makeTap(requestBox))
        engine.prepare()
        try engine.start()
        isRunning = true
        beginTask()
    }

    func stop() {
        silenceTimer?.invalidate()
        generation += 1
        task?.cancel()
        task = nil
        requestBox.replace(with: nil)
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        isRunning = false
        transcript = ""
    }

    /// Throws away what was heard so far (for example our own voice) and listens fresh.
    func discardCurrent() {
        guard isRunning else { return }
        silenceTimer?.invalidate()
        beginTask()
    }

    private func beginTask() {
        guard let recognizer else { return }
        generation += 1
        task?.cancel()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        requestBox.replace(with: request)
        transcript = ""
        task = recognizer.recognitionTask(with: request, resultHandler: Self.makeHandler(generation: generation, owner: self))
    }

    private func handle(generation: Int, text: String?, isFinal: Bool, failed: Bool) {
        guard generation == self.generation, isRunning else { return }
        if let text, !text.isEmpty, text != transcript {
            transcript = text
            onPartial?(text)
            restartSilenceTimer()
        }
        if isFinal {
            finishUtterance()
        } else if failed {
            // The recognizer gives up after long silence or a network hiccup; keep listening.
            if transcript.isEmpty {
                Task { @MainActor [weak self] in
                    try? await Task.sleep(nanoseconds: 300_000_000)
                    guard let self, self.isRunning, generation == self.generation else { return }
                    self.beginTask()
                }
            } else {
                finishUtterance()
            }
        }
    }

    private func restartSilenceTimer() {
        silenceTimer?.invalidate()
        let current = generation
        silenceTimer = Timer.scheduledTimer(withTimeInterval: silenceTimeout, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self, current == self.generation else { return }
                self.finishUtterance()
            }
        }
    }

    private func finishUtterance() {
        silenceTimer?.invalidate()
        let text = transcript.trimmed
        beginTask()
        if !text.isEmpty { onUtterance?(text) }
    }

    // The tap and result callbacks run off the main thread, so they are built outside the actor.
    nonisolated private static func makeTap(_ box: RequestBox) -> AVAudioNodeTapBlock {
        { buffer, _ in box.append(buffer) }
    }

    nonisolated private static func makeHandler(generation: Int, owner: SpeechRecognizer) -> (SFSpeechRecognitionResult?, Error?) -> Void {
        { [weak owner] result, error in
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            let failed = error != nil
            Task { @MainActor in
                owner?.handle(generation: generation, text: text, isFinal: isFinal, failed: failed)
            }
        }
    }
}

/// Hands microphone audio to whichever recognition request is current.
private final class RequestBox: @unchecked Sendable {
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?

    func replace(with newRequest: SFSpeechAudioBufferRecognitionRequest?) {
        lock.lock()
        let old = request
        request = newRequest
        lock.unlock()
        old?.endAudio()
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        let current = request
        lock.unlock()
        current?.append(buffer)
    }
}
