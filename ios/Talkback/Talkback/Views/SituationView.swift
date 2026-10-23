import SwiftUI

/// Describe a situation in Korean and get what a native speaker would say.
struct SituationView: View {
    enum Tone: String, CaseIterable, Identifiable {
        case formal = "격식"
        case neutral = "보통"
        case casual = "캐주얼"

        var id: String { rawValue }

        var english: String {
            switch self {
            case .formal: return "formal and polite (work, customers, strangers)"
            case .neutral: return "neutral and friendly, for everyday situations"
            case .casual: return "casual, as between close friends"
            }
        }
    }

    @EnvironmentObject private var settings: AppSettings
    @StateObject private var speaker = Speaker()
    @StateObject private var dictation = SpeechRecognizer(locale: Locale(identifier: "ko-KR"))
    @State private var text = ""
    @State private var tone: Tone = .neutral
    @State private var phrases: [SituationPhrase] = []
    @State private var searchedText = ""
    @State private var loading = false
    @State private var errorMessage: String?
    @State private var talk: TalkSession?
    @FocusState private var focused: Bool

    private let examples = [
        "회의에 10분 늦을 것 같다고 팀장님께 말하고 싶어",
        "친구 초대를 기분 상하지 않게 거절하고 싶어",
        "식당에서 주문한 음식과 다른 게 나왔어",
    ]

    var body: some View {
        NavigationStack {
            List {
                Section {
                    TextField("예: 회의에 늦을 것 같다고 정중하게 말하고 싶어", text: $text, axis: .vertical)
                        .lineLimit(2...5)
                        .focused($focused)
                    HStack {
                        Button(action: toggleDictation) {
                            Label(dictation.isRunning ? "듣는 중 · 탭하면 멈춰요" : "한국어로 말하기",
                                  systemImage: dictation.isRunning ? "stop.circle.fill" : "mic.fill")
                        }
                        .buttonStyle(.borderless)
                        Spacer()
                        Button("표현 찾기") { Task { await find() } }
                            .buttonStyle(.borderedProminent)
                            .disabled(text.trimmed.isEmpty || loading)
                    }
                } header: {
                    Text("어떤 상황인지 한국어로 알려 주세요")
                }

                Section("말투") {
                    Picker("말투", selection: $tone) {
                        ForEach(Tone.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                }

                if loading {
                    Section {
                        HStack(spacing: 12) {
                            ProgressView()
                            Text("원어민 표현을 찾는 중이에요…")
                        }
                    }
                }

                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }

                if phrases.isEmpty && !loading {
                    Section("예시 상황") {
                        ForEach(examples, id: \.self) { example in
                            Button(example) { text = example }
                        }
                    }
                }

                if !phrases.isEmpty {
                    Section("이렇게 말해 보세요") {
                        ForEach(phrases) { phrase in
                            VStack(alignment: .leading, spacing: 6) {
                                HStack(alignment: .top) {
                                    Text(phrase.en).font(.headline)
                                    Spacer()
                                    SpeakButton {
                                        speaker.rate = settings.speechRate
                                        speaker.say(phrase.en)
                                    }
                                }
                                Text(phrase.ko).font(.subheadline).foregroundStyle(.secondary)
                                Text(phrase.tip)
                                    .font(.footnote)
                                    .padding(8)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(Theme.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
                            }
                            .padding(.vertical, 4)
                        }
                    }
                    Section {
                        Button(action: startRolePlay) {
                            Label("이 상황으로 롤플레이 연습하기", systemImage: "mic.circle.fill")
                        }
                    }
                }
            }
            .navigationTitle("이럴 땐 영어로?")
            .onAppear {
                dictation.onUtterance = { said in
                    text = said
                    dictation.stop()
                }
            }
            .onDisappear { dictation.stop() }
            .onChange(of: dictation.transcript) { _, heard in
                if dictation.isRunning, !heard.isEmpty { text = heard }
            }
            .onChange(of: tone) { _, _ in
                if !phrases.isEmpty { Task { await find() } }
            }
            .fullScreenCover(item: $talk) { session in
                TalkView(session: session, settings: settings)
            }
        }
    }

    private func toggleDictation() {
        if dictation.isRunning {
            dictation.stop()
            return
        }
        focused = false
        Task {
            guard await SpeechRecognizer.requestPermissions() else {
                errorMessage = SpeechRecognizer.RecognizerError.notAuthorized.localizedDescription
                return
            }
            do {
                try dictation.start()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func find() async {
        let situation = text.trimmed
        guard !situation.isEmpty, !loading else { return }
        dictation.stop()
        focused = false
        loading = true
        errorMessage = nil
        defer { loading = false }
        do {
            let result = try await Claude.json(
                SituationResult.self,
                system: "You help a Korean learner say things the way native English speakers do. Write every Korean field in natural Korean.",
                prompt: """
                The learner describes a situation in Korean and wants to know what a native English speaker would naturally say.

                Situation: \(situation)
                Tone: \(tone.english)

                Give 3 natural expressions or short sentences for exactly this situation in that tone. For each:
                - en: the English line
                - ko: a natural Korean translation
                - tip: one short Korean sentence on its nuance or when to use it
                """,
                schema: SituationResult.schema,
                effort: "low"
            )
            phrases = result.phrases
            searchedText = situation
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func startRolePlay() {
        dictation.stop()
        let scenario = Scenario(
            title: "상황 연습",
            partnerName: "Alex",
            partnerRole: "the other person in this situation",
            setupKo: searchedText,
            setup: "The learner described this situation in Korean: \"\(searchedText)\". Play the other person in it, speaking in a \(tone.english) tone. Start the scene so the learner gets to say what they need to say.",
            openingLine: ""
        )
        let targets = phrases.map {
            LessonExpression(phrase: $0.en, meaningKo: $0.ko, nuanceKo: $0.tip, alternatives: [], example: $0.en, exampleKo: $0.ko, matchKeywords: [])
        }
        talk = TalkSession(scenario: scenario, expressions: targets)
    }
}
