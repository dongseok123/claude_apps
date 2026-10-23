import SwiftUI

struct FeedbackInput {
    let transcript: String
    let scenario: Scenario
    let expressions: [LessonExpression]
    let used: Set<String>
    let learnerTurns: Int
}

struct FeedbackView: View {
    let input: FeedbackInput
    @ObservedObject var settings: AppSettings
    let onDone: () -> Void

    @StateObject private var speaker = Speaker()
    @State private var feedback: Feedback?
    @State private var loading = false
    @State private var errorMessage: String?
    @State private var rated = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        stat("\(input.used.count)/\(input.expressions.count)", "사용한 표현")
                        stat("\(input.learnerTurns)", "내가 말한 횟수")
                    }
                }

                if input.learnerTurns == 0 {
                    Section {
                        Text("이번 대화에서는 말한 내용이 없어서 피드백을 만들지 않았어요.")
                    }
                } else if loading {
                    Section {
                        HStack(spacing: 12) {
                            ProgressView()
                            Text("피드백을 만드는 중이에요…")
                        }
                    }
                } else if let errorMessage {
                    Section {
                        Text(errorMessage).foregroundStyle(.red)
                        Button("다시 시도") { Task { await load() } }
                    }
                }

                if let feedback {
                    feedbackSections(feedback)
                }

                let unused = input.expressions.filter { !input.used.contains($0.phrase) }
                if !unused.isEmpty {
                    Section("다음에 써 볼 표현") {
                        ForEach(unused) { expression in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(expression.phrase).font(.headline)
                                Text(expression.meaningKo).font(.subheadline).foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                Section("오늘 난이도는 어땠나요?") {
                    if rated {
                        Text("다음 수업은 \(settings.level.label) 난이도로 만들어요.")
                    } else {
                        rateButton("너무 쉬웠어요", step: 1)
                        rateButton("딱 좋아요", step: 0)
                        rateButton("너무 어려웠어요", step: -1)
                    }
                }
            }
            .navigationTitle("피드백")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("완료", action: onDone)
                }
            }
            .task {
                settings.markPracticedToday()
                await load()
            }
        }
    }

    @ViewBuilder private func feedbackSections(_ feedback: Feedback) -> some View {
        if !feedback.good.isEmpty {
            Section("자연스러웠던 점") {
                ForEach(feedback.good, id: \.self) { Text($0) }
            }
        }
        Section("고칠 점") {
            if feedback.fixes.isEmpty {
                Text("고칠 부분이 없었어요. 잘했어요!")
            }
            ForEach(feedback.fixes, id: \.self) { fix in
                VStack(alignment: .leading, spacing: 4) {
                    Text(fix.said).strikethrough().foregroundStyle(.secondary)
                    HStack(alignment: .top) {
                        Text(fix.better).font(.body.bold()).foregroundStyle(Theme.accent)
                        Spacer()
                        SpeakButton { say(fix.better) }
                    }
                    Text(fix.why).font(.footnote).foregroundStyle(.secondary)
                }
                .padding(.vertical, 2)
            }
        }
        Section("원어민이라면") {
            HStack(alignment: .top) {
                Text(feedback.native)
                Spacer()
                SpeakButton { say(feedback.native) }
            }
        }
        Section("다음 팁") {
            Text(feedback.nextTip)
        }
    }

    private func stat(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value).font(.title2.bold().monospacedDigit())
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func rateButton(_ title: String, step: Int) -> some View {
        Button(title) {
            settings.level = settings.level.adjusted(by: step)
            rated = true
        }
    }

    private func say(_ text: String) {
        speaker.rate = settings.speechRate
        speaker.say(text)
    }

    private func load() async {
        guard input.learnerTurns > 0, feedback == nil, !loading else { return }
        loading = true
        errorMessage = nil
        defer { loading = false }
        do {
            feedback = try await Claude.json(
                Feedback.self,
                system: "You are an encouraging English speaking coach for a Korean learner. Write every Korean field in natural Korean.",
                prompt: prompt,
                schema: Feedback.schema
            )
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private var prompt: String {
        """
        Review the learner's lines in this role-play and give feedback.

        Learner level: \(settings.level.guide)
        Scenario: \(input.scenario.setup)
        Target expressions: \(input.expressions.map(\.phrase).joined(separator: "; "))

        Transcript (the learner's lines come from speech recognition, so ignore punctuation, capitalization and obvious recognition errors):
        \(input.transcript)

        Return:
        - good: 1-3 things the learner did well, in Korean, quoting the English they used
        - fixes: up to 5 real grammar, word-choice or naturalness problems. said = the learner's original words, better = natural corrected English, why = a short reason in Korean. Return an empty list if there are none.
        - native: how a native speaker might have said the learner's key lines, 2-4 sentences of English
        - nextTip: one concrete tip for next time, in Korean
        """
    }
}
