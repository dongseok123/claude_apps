import Combine
import SwiftUI
import UserNotifications

@main
struct TalkbackApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var settings = AppSettings()
    @StateObject private var store = LessonStore()
    @StateObject private var router = Router.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(settings)
                .environmentObject(store)
                .environmentObject(router)
                .task {
                    if settings.reminderOn, await NotificationScheduler.requestPermission() {
                        settings.updateReminder()
                    }
                }
        }
    }
}

/// Carries "open the conversation" from a tapped reminder to the Today tab.
@MainActor
final class Router: ObservableObject {
    static let shared = Router()
    @Published var pendingTalk = false
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        Task { @MainActor in Router.shared.pendingTalk = true }
        completionHandler()
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }
}

enum Theme {
    static let accent = Color(red: 0.184, green: 0.357, blue: 0.918)
    static let orange = Color(red: 0.941, green: 0.541, blue: 0.141)
    static let night = Color(red: 0.055, green: 0.086, blue: 0.188)
    static let partnerBubble = Color(red: 0.106, green: 0.149, blue: 0.314)
    static let learnerBubble = Color(red: 0.141, green: 0.192, blue: 0.416)
}
