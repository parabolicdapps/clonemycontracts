import Foundation
import SwiftUI

/// Owns the engine child process: spawn, handshake, secret channel, crash restart with backoff, clean shutdown.
///
/// Contract (engine side: apps/api/src/main.ts, local.ts, secrets.ts):
///  - run `<engine>/node <engine>/app/apps/api/dist/main.js` with CMC_SECRET_STORE=shell, CMC_ANVIL=<engine>/anvil
///  - stdout line 1 = {"port":N,"token":"<hex>"}; later stdout lines = secret-set / secret-delete for the Keychain
///  - stdin: first {"type":"secrets","values":{...}}, later {"type":"secret",...}. stdin stays OPEN; closing it = shutdown.
///  - stderr = log lines
///  - login: POST /api/auth/code (Bearer token) -> {code}; the window loads /auth/exchange?code=<code> and gets the cookie.
@MainActor
final class EngineController: ObservableObject {
    enum State: Equatable {
        case stopped
        case starting
        case running(port: Int)
        case failed(String)
    }

    @Published private(set) var state: State = .stopped
    @Published private(set) var logLines: [String] = []
    /// bumped whenever a (re)started engine is ready, so the web view reloads through a fresh sign-in code
    @Published private(set) var generation = 0

    private var process: Process?
    private var stdinHandle: FileHandle?
    private var token: String?
    private var stopping = false
    private var restartDelay: TimeInterval = 1
    private var startedAt = Date()
    private var handshakeTimer: Task<Void, Never>?
    private var restartTask: Task<Void, Never>?
    private let maxLog = 3000

    // MARK: locations

    /// `Contents/Resources/engine/`, or $CMC_ENGINE_DIR for development against a staged tree.
    static var engineDir: URL {
        if let d = ProcessInfo.processInfo.environment["CMC_ENGINE_DIR"] { return URL(fileURLWithPath: d) }
        return Bundle.main.resourceURL!.appendingPathComponent("engine")
    }
    static var nodeURL: URL { engineDir.appendingPathComponent("node") }
    static var mainJS: URL { engineDir.appendingPathComponent("app/apps/api/dist/main.js") }

    var baseURL: URL? { if case .running(let p) = state { return URL(string: "http://127.0.0.1:\(p)") } else { return nil } }

    // MARK: lifecycle

    func start() {
        guard process == nil else { return }
        stopping = false
        let fm = FileManager.default
        guard fm.isExecutableFile(atPath: Self.nodeURL.path), fm.fileExists(atPath: Self.mainJS.path) else {
            state = .failed("The engine is missing from the app bundle (\(Self.engineDir.path)). Run scripts/bundle-engine.sh.")
            return
        }
        state = .starting
        token = nil
        let p = Process()
        p.executableURL = Self.nodeURL
        p.arguments = [Self.mainJS.path]
        p.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        var env = ProcessInfo.processInfo.environment
        let extra = ["\(Self.engineDir.path)", "/opt/homebrew/bin", "/usr/local/bin", "\(NSHomeDirectory())/.orbstack/bin", "\(NSHomeDirectory())/.local/bin", "/usr/bin", "/bin"]
        env["PATH"] = (extra + (env["PATH"]?.split(separator: ":").map(String.init) ?? [])).joined(separator: ":")
        env["CMC_SECRET_STORE"] = "shell"
        env["CMC_ANVIL"] = Self.engineDir.appendingPathComponent("anvil").path
        env["NODE_ENV"] = "production"
        for k in ["CMC_HOSTED", "CMC_HOST", "CMC_AUTH_TOKEN"] { env.removeValue(forKey: k) } // never inherit hosted-mode settings
        p.environment = env

        let inPipe = Pipe(), outPipe = Pipe(), errPipe = Pipe()
        p.standardInput = inPipe; p.standardOutput = outPipe; p.standardError = errPipe
        stdinHandle = inPipe.fileHandleForWriting

        let outReader = LineReader { [weak self] line in Task { @MainActor in self?.onStdout(line) } }
        outPipe.fileHandleForReading.readabilityHandler = { h in
            let d = h.availableData
            if d.isEmpty { h.readabilityHandler = nil; return }
            outReader.feed(d)
        }
        let errReader = LineReader { [weak self] line in Task { @MainActor in self?.appendLog(line) } }
        errPipe.fileHandleForReading.readabilityHandler = { h in
            let d = h.availableData
            if d.isEmpty { h.readabilityHandler = nil; return }
            errReader.feed(d)
        }
        p.terminationHandler = { [weak self] proc in
            Task { @MainActor in self?.onExit(proc) }
        }
        do { try p.run() } catch {
            state = .failed("Could not start the engine: \(error.localizedDescription)")
            scheduleRestart()
            return
        }
        process = p
        startedAt = Date()
        appendLog("[shell] engine started, pid \(p.processIdentifier)")
        // all saved keys, once, before anything else
        send(["type": "secrets", "values": Keychain.all()])
        handshakeTimer?.cancel()
        handshakeTimer = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 30_000_000_000)
            guard !Task.isCancelled, let self else { return }
            if case .starting = self.state { self.appendLog("[shell] no handshake within 30 s, killing the engine"); self.process?.terminate() }
        }
    }

    private func onStdout(_ line: String) {
        guard let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { appendLog(line); return }
        if case .starting = state, let port = obj["port"] as? Int, let tok = obj["token"] as? String {
            token = tok
            handshakeTimer?.cancel()
            state = .running(port: port)
            generation += 1
            appendLog("[shell] handshake ok, port \(port)")
            return
        }
        switch obj["type"] as? String {
        case "secret-set":
            if let id = obj["id"] as? String, let v = obj["value"] as? String { if !Keychain.set(id, v) { appendLog("[shell] Keychain refused to store \(id)") } }
        case "secret-delete":
            if let id = obj["id"] as? String { Keychain.delete(id) }
        default: appendLog(line.count > 300 ? String(line.prefix(300)) + "..." : line)
        }
    }

    private func onExit(_ proc: Process) {
        guard proc === process else { return }
        process = nil
        try? stdinHandle?.close(); stdinHandle = nil
        handshakeTimer?.cancel()
        appendLog("[shell] engine exited, status \(proc.terminationStatus)")
        if stopping { state = .stopped; return }
        state = .failed("The engine stopped unexpectedly (exit \(proc.terminationStatus)). Restarting...")
        scheduleRestart()
    }

    private func scheduleRestart() {
        if Date().timeIntervalSince(startedAt) > 60 { restartDelay = 1 }
        let d = restartDelay
        restartDelay = min(restartDelay * 2, 30)
        appendLog("[shell] restarting in \(Int(d)) s")
        restartTask?.cancel()
        restartTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(d * 1_000_000_000))
            guard !Task.isCancelled, let self, !self.stopping else { return }
            self.start()
        }
    }

    /// Restart on request (menu), without the crash backoff.
    func restart() {
        restartTask?.cancel()
        stopSync()
        stopping = false
        restartDelay = 1
        start()
    }

    /// Blocking clean shutdown, safe to call from applicationWillTerminate: close stdin (the engine's own stop signal),
    /// wait up to 6 s, then SIGTERM, then SIGKILL. Children (anvil, docker clients) are collected first and killed too.
    func stopSync() {
        stopping = true
        restartTask?.cancel(); handshakeTimer?.cancel()
        guard let p = process else { state = .stopped; return }
        let kids = Self.descendants(of: p.processIdentifier)
        try? stdinHandle?.close(); stdinHandle = nil
        if !Self.wait(p, seconds: 6) {
            p.terminate()
            if !Self.wait(p, seconds: 4) { kill(p.processIdentifier, SIGKILL) }
        }
        for k in kids where kill(k, 0) == 0 { kill(k, SIGTERM) }
        usleep(300_000)
        for k in kids where kill(k, 0) == 0 { kill(k, SIGKILL) }
        process = nil
        state = .stopped
    }

    // MARK: secrets / auth

    /// One key changed in the native sheet: the engine takes it live over stdin, no restart needed.
    func pushSecret(id: String, value: String) { send(["type": "secret", "id": id, "value": value]) }

    private func send(_ obj: [String: Any]) {
        guard let h = stdinHandle, let d = try? JSONSerialization.data(withJSONObject: obj) else { return }
        try? h.write(contentsOf: d + Data("\n".utf8))
    }

    /// One-time sign-in URL for the web view. The long-lived token never appears in a URL.
    func signInURL() async -> URL? {
        guard let base = baseURL, let token else { return nil }
        var r = URLRequest(url: base.appendingPathComponent("api/auth/code"))
        r.httpMethod = "POST"
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        r.timeoutInterval = 10
        guard let (data, resp) = try? await URLSession.shared.data(for: r), (resp as? HTTPURLResponse)?.statusCode == 200,
              let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let code = j["code"] as? String else { return nil }
        var c = URLComponents(url: base.appendingPathComponent("auth/exchange"), resolvingAgainstBaseURL: false)!
        c.queryItems = [URLQueryItem(name: "code", value: code)]
        return c.url
    }

    // MARK: log

    func appendLog(_ s: String) {
        logLines.append(s)
        if logLines.count > maxLog { logLines.removeFirst(logLines.count - maxLog) }
    }

    // MARK: helpers

    private static func wait(_ p: Process, seconds: Double) -> Bool {
        let end = Date().addingTimeInterval(seconds)
        while p.isRunning && Date() < end { usleep(50_000) }
        return !p.isRunning
    }

    private static func descendants(of pid: Int32) -> [Int32] {
        let t = Process(); t.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep"); t.arguments = ["-P", String(pid)]
        let o = Pipe(); t.standardOutput = o; t.standardError = FileHandle.nullDevice
        guard (try? t.run()) != nil else { return [] }
        let d = o.fileHandleForReading.readDataToEndOfFile(); t.waitUntilExit()
        let kids = (String(data: d, encoding: .utf8) ?? "").split(separator: "\n").compactMap { Int32($0) }
        return kids + kids.flatMap { descendants(of: $0) }
    }
}

/// Splits a byte stream into lines (UTF-8) off the main thread.
final class LineReader: @unchecked Sendable {
    private var buf = Data()
    private let lock = NSLock()
    private let onLine: @Sendable (String) -> Void
    init(_ onLine: @escaping @Sendable (String) -> Void) { self.onLine = onLine }
    func feed(_ d: Data) {
        lock.lock(); buf.append(d)
        var lines: [String] = []
        while let i = buf.firstIndex(of: 0x0A) {
            lines.append(String(decoding: buf[buf.startIndex..<i], as: UTF8.self))
            buf = Data(buf[buf.index(after: i)...])
        }
        lock.unlock()
        lines.filter { !$0.isEmpty }.forEach(onLine)
    }
}
