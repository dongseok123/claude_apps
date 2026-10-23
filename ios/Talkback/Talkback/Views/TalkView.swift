import SwiftUI

struct TalkView: View {
    @StateObject private var engine: ConversationEngine
    @ObservedObject private var settings: AppSettings
    @Environment(\.dismiss) private var dismiss
    @State private var showHints = false
    @State private var feedback: FeedbackInput?

    init(session: TalkSession, settings: AppSettings) {
        _engine = StateObject(wrappedValue: ConversationEngine(session: session, settings: settings))
        _settings = ObservedObject(wrappedValue: settings)
    }

    var body: some View {
        if let feedback {
            FeedbackView(input: feedback, settings: settings) { dismiss() }
        } else {
            conversation
        }
    }

    private var scenario: Scenario { engine.session.scenario }

    private var conversation: some View {
        VStack(spacing: 16) {
            topBar
            partner
            transcript
            controls
        }
        .padding(.top, 8)
        .foregroundStyle(.white)
        .background(Theme.night.ignoresSafeArea())
        .task { await engine.start() }
        .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
        .onDisappear {
            UIApplication.shared.isIdleTimerDisabled = false
            engine.end()
        }
        .sheet(isPresented: $showHints) {
            HintSheet(expressions: engine.session.expressions, used: engine.usedPhrases)
        }
        .alert("문제가 생겼어요", isPresented: errorShown) {
            Button("확인", role: .cancel) {}
        } message: {
            Text(engine.errorMessage ?? "")
        }
    }

    private var topBar: some View {
        HStack(spacing: 8) {
            Text(scenario.title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.white.opacity(0.75))
                .lineLimit(1)
            Spacer()
            Button(action: cycleRate) {
                Text(String(format: "%gx", settings.speechRate))
                    .font(.footnote.bold().monospacedDigit())
                    .frame(minWidth: 52, minHeight: 32)
                    .background(Theme.partnerBubble, in: Capsule())
            }
            .accessibilityLabel("원어민 말하기 속도 바꾸기")
            Button { showHints = true } label: {
                Text("표현 \(engine.usedPhrases.count)/\(engine.session.expressions.count)")
                    .font(.footnote.bold().monospacedDigit())
                    .padding(.horizontal, 10)
                    .frame(minHeight: 32)
                    .background(Theme.partnerBubble, in: Capsule())
                    .foregroundStyle(Theme.orange)
            }
        }
        .padding(.horizontal)
    }

    private var partner: some View {
        VStack(spacing: 8) {
            Text(String(scenario.partnerName.prefix(1)))
                .font(.system(size: 40, weight: .heavy))
                .frame(width: 92, height: 92)
                .background(Theme.accent, in: Circle())
                .overlay {
                    Circle()
                        .stroke(Theme.accent.opacity(0.5), lineWidth: 6)
                        .scaleEffect(engine.phase == .speaking ? 1.25 : 1)
                        .opacity(engine.phase == .speaking ? 1 : 0)
                        .animation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true), value: engine.phase == .speaking)
                }
            Text(scenario.partnerName).font(.title3.bold())
            Text(status)
                .font(.footnote)
                .foregroundStyle(Color.white.opacity(0.7))
        }
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: 10) {
                    ForEach(engine.lines) { line in
                        Bubble(text: line.text, isLearner: line.role == .user)
                            .id(line.id)
                    }
                    if engine.phase == .listening, !engine.heard.isEmpty {
                        Bubble(text: engine.heard, isLearner: true, isLive: true)
                            .id("live")
                    }
                }
                .padding(.horizontal)
            }
            .onChange(of: engine.lines.last?.text) { _, _ in
                if let id = engine.lines.last?.id {
                    withAnimation { proxy.scrollTo(id, anchor: .bottom) }
                }
            }
            .onChange(of: engine.heard) { _, _ in
                withAnimation { proxy.scrollTo("live", anchor: .bottom) }
            }
        }
    }

    private var controls: some View {
        VStack(spacing: 8) {
            HStack {
                roundButton("lightbulb.fill", label: "힌트 보기", color: Theme.partnerBubble) { showHints = true }
                Spacer()
                Button(action: orbTapped) {
                    Image(systemName: "mic.fill")
                        .font(.system(size: 34, weight: .semibold))
                        .symbolEffect(.pulse, isActive: engine.phase == .listening)
                        .frame(width: 92, height: 92)
                        .background(engine.phase == .listening ? Theme.orange : Theme.accent, in: Circle())
                        .foregroundStyle(engine.phase == .listening ? Color.black : Color.white)
                }
                .accessibilityLabel(orbHint)
                Spacer()
                roundButton("xmark", label: "대화 끝내기", color: .red) { finish() }
            }
            .padding(.horizontal, 28)
            Text(orbHint)
                .font(.caption)
                .foregroundStyle(Color.white.opacity(0.7))
                .multilineTextAlignment(.center)
                .padding(.horizontal)
        }
        .padding(.bottom, 12)
    }

    private func roundButton(_ symbol: String, label: String, color: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.title3.bold())
                .frame(width: 56, height: 56)
                .background(color, in: Circle())
        }
        .accessibilityLabel(label)
    }

    private var status: String {
        switch engine.phase {
        case .idle: return "준비 중…"
        case .listening: return "듣고 있어요 · 편하게 말하세요"
        case .thinking: return "\(scenario.partnerName) 생각 중…"
        case .speaking: return "\(scenario.partnerName) 말하는 중 · 말을 끊어도 돼요"
        }
    }

    private var orbHint: String {
        switch engine.phase {
        case .idle: return "마이크를 준비하고 있어요"
        case .listening: return "말을 멈추면 자동으로 답해요 · 탭하면 상대 말을 다시 들어요"
        case .thinking, .speaking: return "탭하면 상대 말을 끊고 바로 말할 수 있어요"
        }
    }

    private var errorShown: Binding<Bool> {
        Binding(
            get: { engine.errorMessage != nil },
            set: { if !$0 { engine.errorMessage = nil } }
        )
    }

    private func orbTapped() {
        switch engine.phase {
        case .listening: engine.replayLast()
        case .thinking, .speaking: engine.interrupt()
        case .idle: break
        }
    }

    private func cycleRate() {
        let rates = AppSettings.speechRates
        let index = rates.firstIndex(of: settings.speechRate) ?? 1
        engine.setRate(rates[(index + 1) % rates.count])
    }

    private func finish() {
        let input = FeedbackInput(
            transcript: engine.transcript,
            scenario: scenario,
            expressions: engine.session.expressions,
            used: engine.usedPhrases,
            learnerTurns: engine.userTurns
        )
        engine.end()
        feedback = input
    }
}

private struct Bubble: View {
    let text: String
    let isLearner: Bool
    var isLive = false

    var body: some View {
        HStack {
            if isLearner { Spacer(minLength: 40) }
            Text(text.isEmpty ? "…" : text)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(isLearner ? Theme.learnerBubble : Theme.partnerBubble, in: RoundedRectangle(cornerRadius: 18))
                .overlay {
                    if isLive {
                        RoundedRectangle(cornerRadius: 18)
                            .strokeBorder(Theme.orange, style: StrokeStyle(lineWidth: 1.5, dash: [5]))
                    }
                }
            if !isLearner { Spacer(minLength: 40) }
        }
    }
}

private struct HintSheet: View {
    let expressions: [LessonExpression]
    let used: Set<String>

    var body: some View {
        NavigationStack {
            List(expressions) { expression in
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: used.contains(expression.phrase) ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(used.contains(expression.phrase) ? Color.green : Color.secondary)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(expression.phrase).font(.headline)
                        Text(expression.meaningKo).font(.subheadline).foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("오늘의 표현")
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium, .large])
    }
}
