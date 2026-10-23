import Combine
import Foundation

@MainActor
final class AppSettings: ObservableObject {
    static let dailyCounts = [5, 10, 15, 20]
    static let speechRates = [0.75, 0.9, 1.0, 1.2]

    private enum Key {
        static let reminderOn = "reminderOn"
        static let reminderMinutes = "reminderMinutes"
        static let dailyCount = "dailyCount"
        static let speechRate = "speechRate"
        static let level = "level"
        static let practicedDays = "practicedDays"
    }

    @Published var reminderOn: Bool {
        didSet { UserDefaults.standard.set(reminderOn, forKey: Key.reminderOn); updateReminder() }
    }
    /// Minutes after midnight.
    @Published var reminderMinutes: Int {
        didSet { UserDefaults.standard.set(reminderMinutes, forKey: Key.reminderMinutes); updateReminder() }
    }
    @Published var dailyCount: Int {
        didSet { UserDefaults.standard.set(dailyCount, forKey: Key.dailyCount); updateReminder() }
    }
    @Published var speechRate: Double {
        didSet { UserDefaults.standard.set(speechRate, forKey: Key.speechRate) }
    }
    @Published var level: Level {
        didSet { UserDefaults.standard.set(level.rawValue, forKey: Key.level) }
    }
    @Published private(set) var practicedDays: [String]

    init() {
        let defaults = UserDefaults.standard
        defaults.register(defaults: [
            Key.reminderOn: true,
            Key.reminderMinutes: 8 * 60,
            Key.dailyCount: 10,
            Key.speechRate: 0.9,
            Key.level: Level.intermediate.rawValue,
        ])
        reminderOn = defaults.bool(forKey: Key.reminderOn)
        reminderMinutes = defaults.integer(forKey: Key.reminderMinutes)
        dailyCount = defaults.integer(forKey: Key.dailyCount)
        speechRate = defaults.double(forKey: Key.speechRate)
        level = Level(rawValue: defaults.string(forKey: Key.level) ?? "") ?? .intermediate
        practicedDays = defaults.stringArray(forKey: Key.practicedDays) ?? []
    }

    var reminderTime: Date {
        get {
            Calendar.current.date(bySettingHour: reminderMinutes / 60, minute: reminderMinutes % 60, second: 0, of: Date()) ?? Date()
        }
        set {
            let parts = Calendar.current.dateComponents([.hour, .minute], from: newValue)
            reminderMinutes = (parts.hour ?? 8) * 60 + (parts.minute ?? 0)
        }
    }

    /// Days in a row with a finished conversation, counting today or yesterday as the latest.
    var streak: Int {
        let days = Set(practicedDays)
        let calendar = Calendar.current
        var day = Date()
        if !days.contains(DayKey.string(from: day)) {
            day = calendar.date(byAdding: .day, value: -1, to: day) ?? day
        }
        var count = 0
        while days.contains(DayKey.string(from: day)) {
            count += 1
            day = calendar.date(byAdding: .day, value: -1, to: day) ?? day
        }
        return count
    }

    func markPracticedToday() {
        guard !practicedDays.contains(DayKey.today) else { return }
        practicedDays = Array((practicedDays + [DayKey.today]).suffix(400))
        UserDefaults.standard.set(practicedDays, forKey: Key.practicedDays)
    }

    func updateReminder() {
        NotificationScheduler.schedule(enabled: reminderOn, minutes: reminderMinutes, count: dailyCount)
    }
}
