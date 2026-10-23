import Foundation

struct ChatMessage {
    enum Role: String { case user, assistant }
    let role: Role
    let content: String
}

enum ClaudeError: LocalizedError {
    case missingKey
    case http(Int, String)
    case refused
    case badResponse

    var errorDescription: String? {
        switch self {
        case .missingKey:
            return "설정 탭에서 Claude API 키를 먼저 입력해 주세요."
        case .http(let status, let message):
            switch status {
            case 401: return "API 키가 올바르지 않아요. 설정 탭에서 키를 다시 확인해 주세요."
            case 429: return "요청이 많아 잠시 기다려야 해요. 조금 뒤에 다시 시도해 주세요."
            case 529: return "Claude가 지금 붐벼요. 잠시 뒤에 다시 시도해 주세요."
            default: return "Claude 요청이 실패했어요 (\(status)). \(message)"
            }
        case .refused:
            return "Claude가 이 요청에는 답하지 않았어요. 표현을 바꿔서 다시 시도해 주세요."
        case .badResponse:
            return "Claude의 답을 읽지 못했어요. 다시 시도해 주세요."
        }
    }
}

/// Builders for the JSON schemas used with structured outputs.
enum Schema {
    static let string: [String: Any] = ["type": "string"]

    static func array(_ items: [String: Any]) -> [String: Any] {
        ["type": "array", "items": items]
    }

    static func object(_ properties: [String: [String: Any]]) -> [String: Any] {
        ["type": "object", "properties": properties, "required": Array(properties.keys), "additionalProperties": false]
    }
}

/// Minimal client for the Claude Messages API (raw HTTP; there is no official Swift SDK).
enum Claude {
    /// Model for the live role-play. If replies feel slow, try "claude-haiku-5-5" here.
    static let conversationModel = "claude-opus-5-5"
    /// Model for lessons, feedback and phrase suggestions.
    static let coachModel = "claude-opus-5-5"

    private static let endpoint = URL(string: "https://api.anthropic.com/v1/messages")!

    /// Streams the text of a reply as it is written.
    static func streamText(
        model: String = conversationModel,
        system: String,
        messages: [ChatMessage],
        effort: String = "low",
        maxTokens: Int = 4000
    ) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let body: [String: Any] = [
                        "max_tokens": maxTokens,
                        "stream": true,
                        "system": system,
                        "output_config": ["effort": effort],
                        "messages": messages.map { ["role": $0.role.rawValue, "content": $0.content] },
                    ]
                    let (bytes, response) = try await URLSession.shared.bytes(for: Claude.makeRequest(model: model, body: body))
                    if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                        var data = Data()
                        for try await byte in bytes { data.append(byte) }
                        throw ClaudeError.http(http.statusCode, Claude.errorMessage(from: data))
                    }
                    var gotText = false
                    var stopReason: String?
                    for try await line in bytes.lines {
                        guard line.hasPrefix("data:") else { continue }
                        guard let event = try? JSONSerialization.jsonObject(with: Data(line.dropFirst(5).utf8)) as? [String: Any] else { continue }
                        switch event["type"] as? String {
                        case "content_block_delta":
                            if let delta = event["delta"] as? [String: Any],
                               delta["type"] as? String == "text_delta",
                               let text = delta["text"] as? String {
                                gotText = true
                                continuation.yield(text)
                            }
                        case "message_delta":
                            stopReason = (event["delta"] as? [String: Any])?["stop_reason"] as? String
                        case "error":
                            let message = (event["error"] as? [String: Any])?["message"] as? String
                            throw ClaudeError.http(0, message ?? "")
                        default:
                            break
                        }
                    }
                    if stopReason == "refusal" && !gotText { throw ClaudeError.refused }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// Asks for an answer shaped by `schema` and decodes it.
    static func json<T: Decodable>(
        _ type: T.Type,
        model: String = coachModel,
        system: String,
        prompt: String,
        schema: [String: Any],
        effort: String = "medium",
        maxTokens: Int = 16000
    ) async throws -> T {
        let body: [String: Any] = [
            "max_tokens": maxTokens,
            "system": system,
            "output_config": ["effort": effort, "format": ["type": "json_schema", "schema": schema]],
            "messages": [["role": "user", "content": prompt]],
        ]
        let (data, response) = try await URLSession.shared.data(for: makeRequest(model: model, body: body))
        guard let http = response as? HTTPURLResponse else { throw ClaudeError.badResponse }
        guard http.statusCode == 200 else { throw ClaudeError.http(http.statusCode, Claude.errorMessage(from: data)) }
        guard let message = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw ClaudeError.badResponse }
        if message["stop_reason"] as? String == "refusal" { throw ClaudeError.refused }
        // Read only text blocks: the reply can also carry thinking or fallback blocks.
        let text = (message["content"] as? [[String: Any]] ?? [])
            .filter { $0["type"] as? String == "text" }
            .compactMap { $0["text"] as? String }
            .joined()
        do {
            return try JSONDecoder().decode(T.self, from: Data(text.utf8))
        } catch {
            throw ClaudeError.badResponse
        }
    }

    private static func makeRequest(model: String, body: [String: Any]) throws -> URLRequest {
        guard let key = Keychain.apiKey, !key.isEmpty else { throw ClaudeError.missingKey }
        var body = body
        body["model"] = model
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 120
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue(key, forHTTPHeaderField: "x-api-key")
        request.setValue("2026-10-21", forHTTPHeaderField: "anthropic-version")
        // If a safety check declines a request, let the API retry it on its recommended fallback model.
        if model.hasPrefix("claude-opus") || model.hasPrefix("claude-sonnet-5-5") || model.hasPrefix("claude-fable") {
            body["fallbacks"] = "default"
            request.setValue("server-side-fallback-2026-07-01", forHTTPHeaderField: "anthropic-beta")
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return request
    }

    private static func errorMessage(from data: Data) -> String {
        let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        return (object?["error"] as? [String: Any])?["message"] as? String ?? String(decoding: data, as: UTF8.self)
    }
}
