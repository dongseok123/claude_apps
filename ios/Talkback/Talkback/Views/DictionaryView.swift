import SwiftUI
import WebKit

/// Shows live results from online English-Korean dictionaries.
struct DictionaryView: View {
    enum Source: String, CaseIterable, Identifiable {
        case naver = "네이버"
        case daum = "다음"
        case cambridge = "Cambridge"

        var id: String { rawValue }

        func url(for query: String) -> URL? {
            guard let q = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else { return nil }
            switch self {
            case .naver: return URL(string: "https://en.dict.naver.com/#/search?query=\(q)")
            case .daum: return URL(string: "https://dic.daum.net/search.do?q=\(q)&dic=eng")
            case .cambridge: return URL(string: "https://dictionary.cambridge.org/search/direct/?datasetsearch=english-korean&q=\(q)")
            }
        }
    }

    @EnvironmentObject private var settings: AppSettings
    @StateObject private var speaker = Speaker()
    @AppStorage("dictionarySource") private var source: Source = .naver
    @AppStorage("recentWords") private var recentRaw = ""
    @State private var query = ""
    @State private var searched = ""
    @FocusState private var focused: Bool

    private var recents: [String] {
        recentRaw.split(separator: "\n").map(String.init)
    }

    private var isEnglish: Bool {
        searched.range(of: "[A-Za-z]", options: .regularExpression) != nil
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 10) {
                HStack(spacing: 8) {
                    TextField("영어 단어나 표현 (한국어도 돼요)", text: $query)
                        .textFieldStyle(.roundedBorder)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.search)
                        .focused($focused)
                        .onSubmit(search)
                    Button {
                        speaker.rate = settings.speechRate
                        speaker.say(searched)
                    } label: {
                        Image(systemName: "speaker.wave.2.fill")
                            .frame(width: 40, height: 36)
                    }
                    .buttonStyle(.bordered)
                    .disabled(!isEnglish)
                    .accessibilityLabel("미국식 발음 듣기")
                }

                Picker("사전", selection: $source) {
                    ForEach(Source.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)

                if !recents.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(recents, id: \.self) { word in
                                Button(word) {
                                    query = word
                                    search()
                                }
                                .buttonStyle(.bordered)
                                .controlSize(.small)
                            }
                        }
                    }
                }

                if searched.isEmpty {
                    ContentUnavailableView(
                        "단어를 검색해 보세요",
                        systemImage: "character.book.closed",
                        description: Text("네이버 · 다음 · Cambridge 영한사전을 실시간으로 보여드려요.")
                    )
                    Spacer()
                } else {
                    WebView(url: source.url(for: searched))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }
            }
            .padding(.horizontal)
            .padding(.bottom, 8)
            .navigationTitle("영한사전")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func search() {
        let word = query.trimmed
        guard !word.isEmpty else { return }
        focused = false
        searched = word
        recentRaw = ([word] + recents.filter { $0 != word }).prefix(10).joined(separator: "\n")
    }
}

private struct WebView: UIViewRepresentable {
    let url: URL?

    func makeUIView(context: Context) -> WKWebView {
        let webView = WKWebView()
        webView.allowsBackForwardNavigationGestures = true
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard let url, context.coordinator.loadedURL != url else { return }
        context.coordinator.loadedURL = url
        webView.load(URLRequest(url: url))
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator {
        var loadedURL: URL?
    }
}
