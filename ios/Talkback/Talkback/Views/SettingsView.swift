import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var settings: AppSettings
    @StateObject private var speaker = Speaker()
    @State private var apiKey = ""
    @State private var hasKey = Keychain.apiKey != nil

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("매일 연습 알림", isOn: $settings.reminderOn)
                    if settings.reminderOn {
                        DatePicker("알림 시간", selection: $settings.reminderTime, displayedComponents: .hourAndMinute)
                    }
                } header: {
                    Text("연습 알림")
                } footer: {
                    Text("정한 시간에 매일 알림을 보내요. 알림을 누르면 바로 오늘의 대화가 열려요.")
                }

                Section {
                    Picker("하루 표현 개수", selection: $settings.dailyCount) {
                        ForEach(AppSettings.dailyCounts, id: \.self) { Text("\($0)개").tag($0) }
                    }
                    .pickerStyle(.segmented)
                } header: {
                    Text("하루에 배울 표현 개수")
                } footer: {
                    Text("바꾸면 다음에 '오늘' 탭을 열 때 그 개수로 새 수업을 만들어요.")
                }

                Section {
                    Picker("말하기 속도", selection: $settings.speechRate) {
                        ForEach(AppSettings.speechRates, id: \.self) { Text(String(format: "%gx", $0)).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    Button {
                        speaker.rate = settings.speechRate
                        speaker.say("Hey! Did you get a chance to send me that report?")
                    } label: {
                        Label("이 속도로 미리 듣기", systemImage: "speaker.wave.2.fill")
                    }
                } header: {
                    Text("원어민 말하기 속도")
                } footer: {
                    Text("대화 중에도 화면 위쪽의 속도 버튼으로 바로 바꿀 수 있어요. 더 자연스러운 목소리를 원하면 iPhone 설정 > 손쉬운 사용 > 읽기 및 말하기 > 음성에서 영어(미국) '향상된' 음성을 내려받으세요.")
                }

                Section {
                    Picker("난이도", selection: $settings.level) {
                        ForEach(Level.allCases) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.segmented)
                } header: {
                    Text("난이도")
                } footer: {
                    Text("대화가 끝난 뒤 피드백 화면에서 고른 답에 따라 자동으로 바뀌어요.")
                }

                Section {
                    if hasKey {
                        Label("API 키가 저장돼 있어요", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                    }
                    SecureField(hasKey ? "새 키로 바꾸기" : "sk-ant-…", text: $apiKey)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("저장") {
                        Keychain.apiKey = apiKey.trimmed
                        apiKey = ""
                        hasKey = Keychain.apiKey != nil
                    }
                    .disabled(apiKey.trimmed.isEmpty)
                    if hasKey {
                        Button("키 삭제", role: .destructive) {
                            Keychain.apiKey = nil
                            hasKey = false
                        }
                    }
                } header: {
                    Text("Claude API 키")
                } footer: {
                    Text("console.anthropic.com에서 만든 키를 넣어 주세요. 키는 이 iPhone의 키체인에만 저장돼요.")
                }
            }
            .navigationTitle("설정")
            .onChange(of: settings.reminderOn) { _, isOn in
                guard isOn else { return }
                Task {
                    if await NotificationScheduler.requestPermission() { settings.updateReminder() }
                }
            }
        }
    }
}
