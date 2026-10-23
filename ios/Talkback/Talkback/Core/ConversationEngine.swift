import Combine
import Foundation

struct TalkSession: Identifiable {
    let id = UUID()
    let scenario: Scenario
    let expressions: [LessonExpression]
}

/// Runs a hands-free role-play: listen, ask Claude, speak the reply sentence by sentence, repeat.
/// The learner can talk over the partner at any time.
@MainActor
final class ConversationEngine: ObservableObject {
    enum Phase { case idle, listening, thinking, speaking }

    struct Line: Identifiable {
        let id = UUID()
        let role: ChatMessage.Role
        var text: String
    }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var lines: [Line] = []
    /// What the learner is saying right now, before the pause that sends it.
    @Published private(set) var heard = ""
    @Published private(set) var usedPhrases: Set<String> = []
    @Published var errorMessage: String?

    let session: TalkSession
    private let settings: AppSettings
    private let recognizer = SpeechRecognizer()
    private let speaker = Speaker()

    private var history: [ChatMessage] = []
    private var replyTask: Task<Void, Never>?
    private var currentReply = ""
    private var replyCommitted = true
    private var streamDone = true

    init(session: TalkSession, settings: AppSettings) {
        self.session = session
        self.settings = settings
        recognizer.onPartial = { [weak self] text in self?.heardPartial(text) }
        recognizer.onUtterance = { [weak self] text in self?.learnerSaid(text) }
        speaker.onFinished = { [weak self] in self?.speakerFinished() }
    }

    var userTurns: Int { lines.filter { $0.role == .user }.count }

    var transcript: String {
        lines.map { ($0.role == .user ? "Learner: " : "\(session.scenario.partnerName): ") + $0.text }
            .joined(separator: "\n")
    }

    func start() async {
        guard phase == .idle else { return }
        guard await SpeechRecognizer.requestPermissions() else {
            errorMessage = SpeechRecognizer.RecognizerError.notAuthorized.localizedDescription
            return
        }
        do {
            try recognizer.start()
        } catch {
            errorMessage = error.localizedDescription
            return
        }
        history = [ChatMessage(role: .user, content: "(The role-play begins. Say your opening line.)")]
        let opening = session.scenario.openingLine.trimmed
        if opening.isEmpty {
            respond()
        } else {
            history.append(ChatMessage(role: .assistant, content: opening))
            lines = [Line(role: .assistant, text: opening)]
            streamDone = true
            phase = .speaking
            speaker.rate = settings.speechRate
            speaker.enqueue(opening)
        }
    }

    func end() {
        replyTask?.cancel()
        speaker.stop()
        recognizer.stop()
        phase = .idle
        AudioSession.deactivate()
    }

    /// Stops the partner so the learner can talk.
    func interrupt(keepWhatWasHeard: Bool = false) {
        guard phase == .speaking || phase == .thinking else { return }
        replyTask?.cancel()
        streamDone = true
        speaker.stop()
        commitReply()
        lines.removeAll { $0.role == .assistant && $0.text.isEmpty }
        if !keepWhatWasHeard {
            recognizer.discardCurrent()
            heard = ""
        }
        phase = .listening
    }

    func replayLast() {
        guard phase == .listening, let last = lines.last(where: { $0.role == .assistant }) else { return }
        streamDone = true
        phase = .speaking
        speaker.rate = settings.speechRate
        speaker.enqueue(last.text)
    }

    func setRate(_ rate: Double) {
        settings.speechRate = rate
        speaker.rate = rate
    }

    // MARK: - Turn taking

    private func heardPartial(_ text: String) {
        heard = text
        if phase == .speaking, isLearnerVoice(text) {
            interrupt(keepWhatWasHeard: true)
        }
    }

    private func learnerSaid(_ text: String) {
        heard = ""
        // While the partner talks, finished utterances are usually our own voice coming back through the mic.
        guard phase == .listening else { return }
        lines.append(Line(role: .user, text: text))
        history.append(ChatMessage(role: .user, content: text))
        track(text)
        respond()
    }

    private func respond() {
        phase = .thinking
        streamDone = false
        replyCommitted = false
        currentReply = ""
        speaker.rate = settings.speechRate
        let line = Line(role: .assistant, text: "")
        lines.append(line)
        let stream = Claude.streamText(system: systemPrompt, messages: recentHistory())
        replyTask = Task { [weak self] in
            var buffer = ""
            do {
                for try await chunk in stream {
                    guard let self, !Task.isCancelled else { return }
                    self.currentReply += chunk
                    self.updateLine(line.id, text: self.currentReply)
                    buffer += chunk
                    while let sentence = Self.takeSentence(from: &buffer) {
                        self.speak(sentence)
                    }
                }
                guard let self, !Task.isCancelled else { return }
                self.speak(buffer)
                self.streamDone = true
                if !self.speaker.isSpeaking { self.speakerFinished() }
            } catch {
                guard let self, !Task.isCancelled else { return }
                self.errorMessage = error.localizedDescription
                self.lines.removeAll { $0.id == line.id && $0.text.isEmpty }
                self.streamDone = true
                self.speaker.stop()
                self.commitReply()
                self.recognizer.discardCurrent()
                self.phase = .listening
            }
        }
    }

    private func speak(_ sentence: String) {
        guard !sentence.trimmed.isEmpty else { return }
        if phase == .thinking { phase = .speaking }
        speaker.enqueue(sentence)
    }

    private func speakerFinished() {
        guard phase == .speaking || phase == .thinking, streamDone else { return }
        commitReply()
        recognizer.discardCurrent()
        heard = ""
        phase = .listening
    }

    private func commitReply() {
        guard !replyCommitted else { return }
        replyCommitted = true
        let text = currentReply.trimmed
        if !text.isEmpty { history.append(ChatMessage(role: .assistant, content: text)) }
    }

    private func updateLine(_ id: UUID, text: String) {
        guard let index = lines.firstIndex(where: { $0.id == id }) else { return }
        lines[index].text = text
    }

    /// The last 40 turns, starting on a learner turn as the API requires.
    private func recentHistory() -> [ChatMessage] {
        var slice = Array(history.suffix(40))
        while slice.first?.role == .assistant { slice.removeFirst() }
        return slice
    }

    /// True when the mic picks up at least three words the partner is not saying, so it is not just echo.
    private func isLearnerVoice(_ text: String) -> Bool {
        let partnerWords = Set(Self.words(speaker.recentText))
        return Self.words(text).filter { !partnerWords.contains($0) }.count >= 3
    }

    private func track(_ text: String) {
        let said = Self.normalize(text)
        for expression in session.expressions {
            let keys = ([expression.phrase] + expression.matchKeywords).map(Self.normalize).filter { !$0.isEmpty }
            if keys.contains(where: { said.contains($0) }) { usedPhrases.insert(expression.phrase) }
        }
    }

    private var systemPrompt: String {
        let scenario = session.scenario
        let targets = session.expressions.map(\.phrase).joined(separator: "; ")
        return """
        You are role-playing as \(scenario.partnerName), \(scenario.partnerRole), in a spoken English conversation practice with a Korean learner.
        Scenario: \(scenario.setup)
        Learner level: \(settings.level.guide)
        Target expressions the learner is practicing: \(targets)

        Rules:
        - Stay in character. Reply with only what \(scenario.partnerName) says out loud: 1-3 short sentences of natural spoken English with contractions. No stage directions, emoji, markdown or lists.
        - Your words are turned into speech, so write them the way they are said.
        - Don't correct the learner's mistakes during the role-play; react the way a real person would.
        - Create natural chances for the learner to use the target expressions, without naming them.
        - The learner's words come from speech recognition and may contain small recognition errors; read them generously.
        - If the learner seems stuck or speaks Korean, rephrase your last line more simply in English.
        - After about 10 exchanges, start wrapping up the conversation naturally.
        """
    }

    nonisolated static func takeSentence(from buffer: inout String) -> String? {
        guard let range = buffer.range(of: #"[.!?]["')\]]*\s+"#, options: .regularExpression) else { return nil }
        let sentence = String(buffer[..<range.upperBound])
        buffer.removeSubrange(..<range.upperBound)
        return sentence
    }

    nonisolated static func words(_ text: String) -> [String] {
        normalize(text).split { !($0.isLetter || $0 == "'") }.map(String.init)
    }

    nonisolated static func normalize(_ text: String) -> String {
        text.lowercased().replacingOccurrences(of: "’", with: "'")
    }
}
