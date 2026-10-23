import Combine
import Foundation

/// Makes one lesson per day and remembers what has been taught so it is not repeated.
@MainActor
final class LessonStore: ObservableObject {
    @Published private(set) var lesson: Lesson?
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?

    private let lessonURL = URL.documentsDirectory.appending(path: "lesson.json")
    private let taughtURL = URL.documentsDirectory.appending(path: "taught.json")

    init() {
        if let data = try? Data(contentsOf: lessonURL) {
            lesson = try? JSONDecoder().decode(Lesson.self, from: data)
        }
    }

    var hasTodaysLesson: Bool { lesson?.date == DayKey.today }

    func prepareToday(settings: AppSettings) async {
        if let lesson, lesson.date == DayKey.today, lesson.expressions.count == settings.dailyCount { return }
        await generate(settings: settings)
    }

    func generate(settings: AppSettings) async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        let taught = (try? JSONDecoder().decode([String].self, from: Data(contentsOf: taughtURL))) ?? []
        let level = settings.level
        do {
            let draft = try await Claude.json(
                LessonDraft.self,
                system: "You are a friendly English coach for a Korean adult learner. Write every Korean field in natural, conversational Korean.",
                prompt: Self.prompt(level: level, count: settings.dailyCount, taught: taught),
                schema: LessonDraft.schema
            )
            let newLesson = Lesson(date: DayKey.today, level: level, expressions: draft.expressions, scenario: draft.scenario)
            lesson = newLesson
            try? JSONEncoder().encode(newLesson).write(to: lessonURL)
            let updated = Array((taught + draft.expressions.map(\.phrase)).suffix(300))
            try? JSONEncoder().encode(updated).write(to: taughtURL)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private static func prompt(level: Level, count: Int, taught: [String]) -> String {
        let avoid = taught.isEmpty ? "(none yet)" : taught.suffix(150).joined(separator: "; ")
        return """
        Create today's English lesson.

        Learner level: \(level.guide)
        Number of expressions: exactly \(count)

        Teach common everyday expressions that native speakers really use in conversation. Do not reuse any of these expressions taught before: \(avoid)

        For each expression:
        - phrase: the expression itself
        - meaningKo: its meaning in Korean
        - nuanceKo: the nuance in Korean (when and how natives use it, its tone, any caution), 1-2 sentences
        - alternatives: 2-3 other English expressions for similar situations
        - example: one natural example sentence
        - exampleKo: Korean translation of the example
        - matchKeywords: 2-4 short lowercase fragments that would show the learner used this expression or an alternative while speaking (for example "swamped", "slammed", "a lot on my plate")

        Then design one role-play scenario where most of these expressions come up naturally:
        - title: a short Korean title
        - partnerName: an English first name for the partner
        - partnerRole: who the partner is to the learner, in English (for example "your coworker")
        - setupKo: 1-2 Korean sentences telling the learner the situation and their goal
        - setup: the same situation in English, written for the partner
        - openingLine: the partner's first spoken line, 1-2 short sentences
        """
    }
}
