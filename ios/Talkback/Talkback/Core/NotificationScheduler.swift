import UserNotifications

/// Schedules the daily "time to practice" reminder.
enum NotificationScheduler {
    private static let identifier = "daily-practice"

    static func requestPermission() async -> Bool {
        (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }

    static func schedule(enabled: Bool, minutes: Int, count: Int) {
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: [identifier])
        guard enabled else { return }

        let content = UNMutableNotificationContent()
        content.title = "오늘의 영어 연습 시간이에요"
        content.body = "새 표현 \(count)개와 롤플레이가 기다리고 있어요. 탭해서 바로 말해 보세요!"
        content.sound = .default

        var time = DateComponents()
        time.hour = minutes / 60
        time.minute = minutes % 60
        let trigger = UNCalendarNotificationTrigger(dateMatching: time, repeats: true)
        center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: trigger), withCompletionHandler: nil)
    }
}
