import Foundation

/// First-screen container runtime check. The engine does its own detection later (GET /api/runtime); this only decides what to tell a new user.
enum RuntimeStatus: Equatable {
    case checking
    case notInstalled
    case installedNotRunning(String)
    case ready(String)
}

enum RuntimeProbe {
    static let dockerPaths = ["/usr/local/bin/docker", "/opt/homebrew/bin/docker", "\(NSHomeDirectory())/.orbstack/bin/docker"]
    static let appHints: [(String, String)] = [("/Applications/Docker.app", "Docker Desktop"), ("/Applications/OrbStack.app", "OrbStack"),
                                              ("/opt/homebrew/bin/colima", "Colima"), ("/usr/local/bin/colima", "Colima")]

    static func check() async -> RuntimeStatus {
        await Task.detached(priority: .utility) { probe() }.value
    }

    private static func probe() -> RuntimeStatus {
        let fm = FileManager.default
        let installedApp = appHints.first { fm.fileExists(atPath: $0.0) }?.1
        guard let docker = dockerPaths.first(where: { fm.isExecutableFile(atPath: $0) }) else {
            return installedApp.map { .installedNotRunning($0) } ?? .notInstalled
        }
        let name = docker.contains("orbstack") ? "OrbStack" : (installedApp ?? "Docker")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: docker); p.arguments = ["info", "--format", "{{.ServerVersion}}"]
        p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
        var env = ProcessInfo.processInfo.environment; env["DOCKER_CLI_HINTS"] = "false"; p.environment = env
        guard (try? p.run()) != nil else { return .installedNotRunning(name) }
        let end = Date().addingTimeInterval(10)
        while p.isRunning && Date() < end { usleep(100_000) }
        if p.isRunning { p.terminate(); return .installedNotRunning(name) }
        return p.terminationStatus == 0 ? .ready(name) : .installedNotRunning(name)
    }
}
