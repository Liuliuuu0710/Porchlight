import Foundation
import SwiftUI
import Combine
import WatchKit

struct CloudItem: Identifiable {
    let id: String
    let text: String
}

@MainActor
final class CloudModel: ObservableObject {
    @Published var signedIn = false
    @Published var connected = false
    @Published var busy = false
    @Published var error = ""
    @Published var status = "请登录云端"
    @Published var alerts: [CloudItem] = []
    @Published var plans: [CloudItem] = []
    @Published var summary = "等待云端数据"
    @Published var image: UIImage?
    @Published var imageDate: Date?
    @Published var live = false
    private let base = URL(string: "https://your-homi.example.com")!
    private var foreground = true
    private var lifecycle = UUID()
    private var needsPassword = false
    private var lastActivity = Date()

    // A single foreground supervisor owns retries, freshness and stream recovery.
    func maintainConnection() async {
        let owner = UUID()
        lifecycle = owner; foreground = true
        defer { if lifecycle == owner { pause() } }
        while !Task.isCancelled && lifecycle == owner {
            if !signedIn && !needsPassword { await connectIfAllowed() }
            guard !Task.isCancelled, lifecycle == owner else { return }
            if signedIn {
                if stream != nil && Date().timeIntervalSince(lastActivity) > 40 {
                    generation = UUID(); stream?.cancel(); stream = nil
                    connected = false; live = false
                    status = "心跳中断 · 正在重新连接"
                }
                resume()
                if let imageDate, Date().timeIntervalSince(imageDate) > 15 { live = false }
            } else if !needsPassword {
                status = "网络暂不可达 · 自动重试中"
            }
            do { try await Task.sleep(for: .seconds(3)) } catch { return }
        }
    }

    private var token = ""
    private var stream: Task<Void, Never>?
    private var generation = UUID()
    private var lastFrame = Date.distantPast
    private let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.httpShouldSetCookies = false
        c.timeoutIntervalForRequest = 45
        c.timeoutIntervalForResource = 3600
        return URLSession(configuration: c)
    }()

    private func request(_ path: String, body: [String: Any]? = nil) -> URLRequest {
        var r = URLRequest(url: base.appendingPathComponent(path))
        r.setValue(token, forHTTPHeaderField: "x-porchlight-auth")
        if let body {
            r.httpMethod = "POST"
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        return r
    }

    private func check(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        if http.statusCode == 401 {
            logout()
            needsPassword = true
            throw NSError(domain: "Homi", code: 401, userInfo: [NSLocalizedDescriptionKey: "密码不正确或登录已失效，请重新登录"])
        }
        guard (200..<300).contains(http.statusCode) else {
            throw NSError(domain: "Homi", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: "云端请求失败（HTTP \(http.statusCode)），请稍后重试"])
        }
    }

    // Ask the server whether authentication is required; never assume it is open.
    func connectIfAllowed() async {
        foreground = true
        if signedIn { resume(); return }
        guard !busy else { return }
        busy = true; error = ""
        defer { busy = false }
        do {
            var r = request("auth")
            r.timeoutInterval = 12
            let (data, response) = try await session.data(for: r)
            try Task.checkCancellation()
            try check(response)
            guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let required = object["required"] as? Bool else { throw URLError(.cannotParseResponse) }
            needsPassword = required
            if required { status = "请输入团队访问密码"; return }
            token = ""; signedIn = true
            resume()
        } catch is CancellationError {
            return
        } catch {
            if (error as? URLError)?.code == .cancelled { return }
            self.error = "无法连接云端，请检查网络后重试。" + error.localizedDescription
        }
    }

    func login(password: String) async {
        foreground = true
        guard !busy else { return }
        busy = true; error = ""
        defer { busy = false }
        do {
            let (data, response) = try await session.data(for: request("auth", body: ["password": password]))
            try check(response)
            let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            guard let value = object?["token"] as? String, !value.isEmpty else { throw URLError(.cannotParseResponse) }
            token = value; signedIn = true; needsPassword = false
            resume()
        } catch { self.error = error.localizedDescription }
    }

    func logout() {
        generation = UUID(); stream?.cancel(); stream = nil
        connected = false; needsPassword = true
        token = ""; signedIn = false; alerts = []; plans = []
        image = nil; imageDate = nil; live = false
        summary = "等待云端数据"; status = "请登录云端"
    }

    func pause() {
        foreground = false; lifecycle = UUID()
        generation = UUID()
        stream?.cancel(); stream = nil; connected = false; live = false
        status = "已暂停 · 回到前台后同步"
    }

    func resume() {
        guard foreground, signedIn, stream == nil else { return }
        lastActivity = Date()
        let current = UUID(); generation = current
        stream = Task {
            while !Task.isCancelled && signedIn && generation == current {
                lastActivity = Date()
                status = "正在连接云端…"
                do {
                    var r = request("api/stream")
                    r.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    let (bytes, response) = try await session.bytes(for: r)
                    try Task.checkCancellation()
                    guard generation == current else { return }
                    try check(response)
                    for try await line in bytes.lines {
                        try Task.checkCancellation()
                        guard generation == current else { return }
                        lastActivity = Date()
                        if line.hasPrefix("data:") {
                            let data = Data(line.dropFirst(5).utf8)
                            if let message = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                                consume(message)
                            }
                        }
                    }
                } catch {
                    if Task.isCancelled || generation != current { return }
                    self.error = error.localizedDescription
                }
                guard !Task.isCancelled, generation == current, signedIn else { return }
                connected = false; live = false; status = "连接中断 · 3 秒后重连"
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    private func consume(_ message: [String: Any]) {
        let type = message["type"] as? String
        if type == "snapshot" || type == "shared", let state = message["state"] as? [String: Any] {
            connected = true; status = "云端已同步"; error = ""
            alerts = (state["alerts"] as? [[String: Any]] ?? []).compactMap { a in
                guard let id = a["id"] as? String, let text = a["message"] as? String else { return nil }
                return CloudItem(id: id, text: text)
            }
            let context = state["homeCtx"] as? [String: Any] ?? [:]
            plans = (context["plans"] as? [[String: Any]] ?? []).compactMap { p in
                guard p["enabled"] as? Bool == true, let id = p["id"] as? String, let text = p["text"] as? String else { return nil }
                return CloudItem(id: id, text: text)
            }
            live = state["live"] is [String: Any]
            let events = state["events"] as? [[String: Any]] ?? []
            summary = events.sorted { ($0["startedAt"] as? Double ?? 0) > ($1["startedAt"] as? Double ?? 0) }.first?["summary"] as? String ?? "云端暂无事件记录"
        } else if type == "frame" {
            guard let jpeg = message["jpeg"] as? String else { live = false; return }
            // Decode at most one image per five seconds on the watch.
            guard Date().timeIntervalSince(lastFrame) >= 5 else { return }
            if let data = Data(base64Encoded: jpeg), let picture = UIImage(data: data) {
                image = picture; imageDate = Date(); lastFrame = Date(); live = true
            }
        }
    }

    private func command(_ name: String, args: [Any]) async throws -> [String: Any] {
        let (data, response) = try await session.data(for: request("api/cmd", body: ["name": name, "args": args]))
        try check(response)
        return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
    }

    func dismiss(_ id: String) async {
        guard !busy, connected else { return }
        busy = true; error = ""
        defer { busy = false }
        do {
            _ = try await command("dismissAlert", args: [id])
            // Server accepted the action; the next shared state is authoritative.
            alerts.removeAll { $0.id == id }
        } catch { self.error = error.localizedDescription }
    }

    func refreshImage() async {
        guard !busy, connected else { return }
        busy = true; error = ""
        defer { busy = false }
        do {
            let result = try await command("grabSnapshot", args: [])
            guard let value = result["value"] as? [String: Any], let path = value["url"] as? String else {
                error = "暂未取得画面，请确认电脑采集网页已开启"; return
            }
            guard let url = URL(string: path, relativeTo: base)?.absoluteURL, url.host == base.host, url.scheme == "https" else { throw URLError(.badURL) }
            var r = URLRequest(url: url)
            r.setValue(token, forHTTPHeaderField: "x-porchlight-auth")
            let (data, response) = try await session.data(for: r)
            try check(response)
            guard let picture = UIImage(data: data) else { throw URLError(.cannotDecodeContentData) }
            image = picture
            imageDate = (value["t"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) } ?? Date()
        } catch { self.error = error.localizedDescription }
    }
}
