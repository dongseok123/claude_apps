import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var store: LessonStore
    @EnvironmentObject private var router: Router
    @State private var talk: TalkSession?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    header
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 8, leading: 4, bottom: 8, trailing: 4))

                content

                if let error = store.errorMessage {
                    Section {
                        Text(error).foregroundStyle(.red)
                        Button("다시 시도") { Task { await store.generate(settings: settings) } }
                    }
                }
            }
            .navigationTitle("오늘")
            .navigationBarTitleDisplayMode(.inline)
            .task {
                await store.prepareToday(settings: settings)
                openPendingTalk()
            }
            .onChange(of: router.pendingTalk) { _, _ in openPendingTalk() }
            .fullScreenCover(item: $talk) { session in
                TalkView(session: session, settings: settings)
            }
        }
    }

    private var header: some View {
        HStack(alignment: .bottom) {
            VStack(alignment: .leading, spacing: 2) {
                Text(settings.streak > 0 ? "\(settings.streak)일 연속 연습 중" : "오늘 첫 연습을 시작해 보세요")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text("Ready to talk?")
                    .font(.largeTitle.bold())
            }
            Spacer()
            Text("Level · \(settings.level.label)")
                .font(.footnote.bold())
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Theme.accent.opacity(0.15), in: Capsule())
                .foregroundStyle(Theme.accent)
        }
    }

    @ViewBuilder private var content: some View {
        if store.isLoading {
            Section {
                HStack(spacing: 12) {
                    ProgressView()
                    Text("오늘의 표현과 롤플레이를 만드는 중이에요…")
                }
            }
        } else if let lesson = store.lesson, store.hasTodaysLesson {
            Section {
                ScenarioCard(scenario: lesson.scenario) {
                    talk = TalkSession(scenario: lesson.scenario, expressions: lesson.expressions)
                }
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets())

            Section("오늘의 표현 \(lesson.expressions.count)개") {
                ForEach(lesson.expressions) { expression in
                    NavigationLink {
                        ExpressionDetailView(expression: expression)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(expression.phrase).font(.headline)
                            Text(expression.meaningKo).font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
    }

    private func openPendingTalk() {
        guard router.pendingTalk, talk == nil, let lesson = store.lesson, store.hasTodaysLesson else { return }
        router.pendingTalk = false
        talk = TalkSession(scenario: lesson.scenario, expressions: lesson.expressions)
    }
}

private struct ScenarioCard: View {
    let scenario: Scenario
    let start: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("오늘의 롤플레이")
                .font(.caption.bold())
                .foregroundStyle(Color.white.opacity(0.7))
            HStack(spacing: 14) {
                Text(String(scenario.partnerName.prefix(1)))
                    .font(.title.bold())
                    .frame(width: 56, height: 56)
                    .background(Theme.accent, in: Circle())
                VStack(alignment: .leading, spacing: 4) {
                    Text(scenario.title).font(.headline)
                    Text(scenario.setupKo)
                        .font(.subheadline)
                        .foregroundStyle(Color.white.opacity(0.75))
                }
            }
            Button(action: start) {
                Label("Start talking", systemImage: "mic.fill")
                    .font(.headline)
                    .frame(maxWidth: .infinity, minHeight: 50)
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.orange)
            .foregroundStyle(.black)
            Text("버튼 없이 말하면 돼요 · 이어폰을 쓰면 더 잘 알아들어요")
                .font(.caption)
                .foregroundStyle(Color.white.opacity(0.6))
                .frame(maxWidth: .infinity)
        }
        .padding(20)
        .foregroundStyle(.white)
        .background(Theme.night, in: RoundedRectangle(cornerRadius: 22))
    }
}

struct ExpressionDetailView: View {
    let expression: LessonExpression
    @EnvironmentObject private var settings: AppSettings
    @StateObject private var speaker = Speaker()

    var body: some View {
        List {
            Section {
                HStack {
                    Text(expression.phrase).font(.title2.bold())
                    Spacer()
                    SpeakButton { say(expression.phrase) }
                }
                Text(expression.meaningKo)
            }
            Section("뉘앙스") {
                Text(expression.nuanceKo)
            }
            Section("예문") {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(expression.example).font(.body.weight(.semibold))
                        Text(expression.exampleKo).font(.subheadline).foregroundStyle(.secondary)
                    }
                    Spacer()
                    SpeakButton { say(expression.example) }
                }
            }
            Section("비슷한 상황에서 쓰는 표현") {
                ForEach(expression.alternatives, id: \.self) { alternative in
                    HStack {
                        Text(alternative)
                        Spacer()
                        SpeakButton { say(alternative) }
                    }
                }
            }
        }
        .navigationTitle("표현")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func say(_ text: String) {
        speaker.rate = settings.speechRate
        speaker.say(text)
    }
}
