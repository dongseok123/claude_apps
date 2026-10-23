import SwiftUI

struct RootView: View {
    @EnvironmentObject private var router: Router
    @State private var tab = 0

    var body: some View {
        TabView(selection: $tab) {
            HomeView()
                .tabItem { Label("오늘", systemImage: "sun.max") }
                .tag(0)
            DictionaryView()
                .tabItem { Label("사전", systemImage: "character.book.closed") }
                .tag(1)
            SituationView()
                .tabItem { Label("상황 표현", systemImage: "text.bubble") }
                .tag(2)
            SettingsView()
                .tabItem { Label("설정", systemImage: "gearshape") }
                .tag(3)
        }
        .tint(Theme.accent)
        .onChange(of: router.pendingTalk) { _, pending in
            if pending { tab = 0 }
        }
    }
}

/// A small speaker button that does not trigger the surrounding list row.
struct SpeakButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "speaker.wave.2.fill")
                .frame(width: 36, height: 36)
        }
        .buttonStyle(.borderless)
        .accessibilityLabel("원어민 발음 듣기")
    }
}
