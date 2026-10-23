# Talkback (iOS)

버튼 없이 말로 주고받는 영어 회화 연습 앱입니다. App Store 없이 내 iPhone에 직접 설치해서 써요.

## 들어 있는 기능

- **오늘의 표현:** 매일 새 표현을 5·10·15·20개 중 정한 개수만큼 받아요. 표현마다 뜻, 뉘앙스, 예문, 비슷한 표현이 있고 발음도 들을 수 있어요.
- **롤플레이 대화:** 말하고 잠깐 멈추면 상대가 원어민 목소리로 바로 답해요. 상대가 말하는 중에 끼어들 수도 있어요.
- **피드백:** 대화가 끝나면 자연스러웠던 점, 고칠 점, 원어민이라면 어떻게 말했을지 알려줘요. 마지막에 난이도를 평가하면 다음 수업 난이도가 바뀌어요.
- **매일 연습 알림:** 정한 시간에 알림이 오고, 알림을 누르면 바로 대화가 열려요.
- **원어민 말하기 속도:** 0.75x · 0.9x · 1.0x · 1.2x 중에 고를 수 있어요. 설정 탭에서 바꾸거나 대화 중에 화면 위쪽 버튼으로 바꿔요.
- **영한사전:** 네이버 · 다음 · Cambridge 영한사전을 실시간으로 보여주고, 미국식 발음을 들을 수 있어요.
- **이럴 땐 영어로?:** 상황을 한국어로 쓰거나 말하면 격식 · 보통 · 캐주얼 말투에 맞는 원어민 표현을 알려줘요. 그 상황으로 바로 롤플레이 연습도 할 수 있어요.

## 내 iPhone에 설치하기 (처음 한 번)

### 1. 준비물
- Mac App Store에서 **Xcode**를 설치해요 (무료, 용량이 커요).
- 터미널에서 Homebrew가 없다면 https://brew.sh 의 설치 명령을 실행해요.
- Xcode 프로젝트 생성 도구인 XcodeGen을 설치해요.
  ```bash
  brew install xcodegen
  ```

### 2. 코드 받기와 프로젝트 만들기
```bash
git clone https://github.com/dongseok123/claude_apps.git
cd claude_apps
git checkout claude/english-daily-expressions-qqn0jc
cd ios/Talkback
xcodegen
open Talkback.xcodeproj
```

### 3. 서명 설정 (Xcode)
1. **Xcode > Settings > Accounts**에서 `+`를 눌러 내 Apple ID로 로그인해요.
2. 왼쪽에서 파란 **Talkback** 프로젝트를 누르고 **TARGETS > Talkback > Signing & Capabilities**로 가요.
3. **Team**에서 내 이름 (Personal Team)을 골라요.
4. Bundle Identifier 관련 오류가 나면 `com.dongseok.talkback`을 `com.내이름.talkback`처럼 나만의 값으로 바꿔요.

### 4. iPhone에서 실행
1. iPhone을 케이블로 Mac에 연결하고, iPhone에서 "이 컴퓨터를 신뢰" 를 눌러요.
2. iPhone에서 **설정 > 개인정보 보호 및 보안 > 개발자 모드**를 켜요 (재시동돼요).
3. Xcode 위쪽 기기 목록에서 내 iPhone을 고르고 ▶ 버튼을 눌러요.
4. 처음엔 "신뢰하지 않는 개발자"라고 나와요. iPhone의 **설정 > 일반 > VPN 및 기기 관리**에서 내 Apple ID를 신뢰해 주세요.

### 5. Claude API 키 넣기
1. https://console.anthropic.com 에 가입하고 결제 수단을 등록해요.
2. **Billing**에서 **월 사용 한도**를 정해 두면 안심이에요.
3. **API Keys**에서 키를 만들어요.
4. 앱의 **설정** 탭 > Claude API 키에 붙여 넣고 저장해요. 키는 iPhone 키체인에만 저장되고 채팅이나 GitHub에 올라가지 않아요.

## 알아 두기

- **무료 Apple ID로 설치하면 7일마다** 앱이 열리지 않아요. 그때 Mac에 연결하고 Xcode에서 ▶를 다시 누르면 돼요 (데이터는 그대로예요).
- **이어폰을 추천해요.** 스피커로 들으면 상대 목소리를 마이크가 다시 듣고 내 말로 착각할 때가 있어요. 이어폰을 쓰면 끼어들기도 더 잘 돼요.
- **답이 느리게 느껴지면** `Talkback/Core/Claude.swift`의 `conversationModel`을 `"claude-haiku-5-5"`로 바꿔 보세요. 더 빠르고 저렴하지만 대화 품질은 조금 낮아질 수 있어요.
- **더 자연스러운 목소리:** iPhone **설정 > 손쉬운 사용 > 읽기 및 말하기 > 음성 > 영어 (미국)**에서 "향상된" 또는 "고품질" 음성을 내려받으면 앱이 자동으로 그 목소리를 써요.

## 친구에게 보내기 (나중에)

Apple Developer Program(연 $99)에 가입하면 TestFlight로 친구를 초대할 수 있어요. 친구는 iPhone에 TestFlight 앱을 깔고 초대 링크로 설치해요. 친구가 쓴 Claude 사용료도 앱에 넣은 키로 청구되니 월 한도를 꼭 걸어 두세요. 친구가 설정 탭에 자기 키를 넣어도 돼요.

## 코드 구조

| 위치 | 내용 |
|---|---|
| `Talkback/Core/Claude.swift` | Claude API 호출 (스트리밍 대화, JSON 응답) |
| `Talkback/Core/ConversationEngine.swift` | 듣기 → 답 생성 → 말하기 반복, 끼어들기 처리 |
| `Talkback/Core/SpeechRecognizer.swift` | 음성 인식, 말이 멈추면 한 문장으로 보내기 |
| `Talkback/Core/Speaker.swift` | 원어민 음성 읽기, 속도 조절 |
| `Talkback/Core/LessonStore.swift` | 하루 한 번 수업 만들기, 배운 표현 기록 |
| `Talkback/Core/AppSettings.swift` | 알림 시간, 표현 개수, 속도, 난이도 |
| `Talkback/Views/` | 화면 (오늘, 대화, 피드백, 사전, 상황 표현, 설정) |
