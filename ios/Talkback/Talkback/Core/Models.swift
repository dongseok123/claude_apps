import Foundation

enum Level: String, Codable, CaseIterable, Identifiable {
    case beginner, intermediate, advanced

    var id: String { rawValue }

    var label: String {
        switch self {
        case .beginner: return "Easy"
        case .intermediate: return "Mid"
        case .advanced: return "Hard"
        }
    }

    var guide: String {
        switch self {
        case .beginner:
            return "Beginner (CEFR A2-B1): short, simple sentences, slow and clear, very common words; no idioms except the target expressions."
        case .intermediate:
            return "Intermediate (CEFR B1-B2): natural everyday speech with contractions and a few common idioms."
        case .advanced:
            return "Advanced (CEFR C1): fast, casual native speech with slang, phrasal verbs, idioms and the occasional unexpected question."
        }
    }

    func adjusted(by step: Int) -> Level {
        let all = Level.allCases
        let index = all.firstIndex(of: self) ?? 1
        return all[max(0, min(all.count - 1, index + step))]
    }
}

struct LessonExpression: Codable, Hashable, Identifiable {
    var id: String { phrase }
    let phrase: String
    let meaningKo: String
    let nuanceKo: String
    let alternatives: [String]
    let example: String
    let exampleKo: String
    /// Lowercase fragments that show the learner used this expression (or an alternative).
    let matchKeywords: [String]

    static var schema: [String: Any] {
        Schema.object([
            "phrase": Schema.string,
            "meaningKo": Schema.string,
            "nuanceKo": Schema.string,
            "alternatives": Schema.array(Schema.string),
            "example": Schema.string,
            "exampleKo": Schema.string,
            "matchKeywords": Schema.array(Schema.string),
        ])
    }
}

struct Scenario: Codable, Hashable {
    let title: String
    let partnerName: String
    let partnerRole: String
    let setupKo: String
    let setup: String
    /// Empty means the partner's first line is written live by Claude.
    let openingLine: String

    static var schema: [String: Any] {
        Schema.object([
            "title": Schema.string,
            "partnerName": Schema.string,
            "partnerRole": Schema.string,
            "setupKo": Schema.string,
            "setup": Schema.string,
            "openingLine": Schema.string,
        ])
    }
}

struct Lesson: Codable {
    let date: String
    let level: Level
    let expressions: [LessonExpression]
    let scenario: Scenario
}

/// What Claude writes for a new lesson; the app adds the date and level.
struct LessonDraft: Codable {
    let expressions: [LessonExpression]
    let scenario: Scenario

    static var schema: [String: Any] {
        Schema.object([
            "expressions": Schema.array(LessonExpression.schema),
            "scenario": Scenario.schema,
        ])
    }
}

struct Fix: Codable, Hashable {
    let said: String
    let better: String
    let why: String
}

struct Feedback: Codable {
    let good: [String]
    let fixes: [Fix]
    let native: String
    let nextTip: String

    static var schema: [String: Any] {
        Schema.object([
            "good": Schema.array(Schema.string),
            "fixes": Schema.array(Schema.object([
                "said": Schema.string,
                "better": Schema.string,
                "why": Schema.string,
            ])),
            "native": Schema.string,
            "nextTip": Schema.string,
        ])
    }
}

struct SituationPhrase: Codable, Hashable, Identifiable {
    var id: String { en }
    let en: String
    let ko: String
    let tip: String
}

struct SituationResult: Codable {
    let phrases: [SituationPhrase]

    static var schema: [String: Any] {
        Schema.object([
            "phrases": Schema.array(Schema.object([
                "en": Schema.string,
                "ko": Schema.string,
                "tip": Schema.string,
            ])),
        ])
    }
}

enum DayKey {
    private static let formatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    static func string(from date: Date) -> String { formatter.string(from: date) }
    static var today: String { string(from: Date()) }
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
