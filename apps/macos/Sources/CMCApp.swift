import SwiftUI
import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    @MainActor static let engine = EngineController()
    var engine: EngineController? { MainActor.assumeIsolated { Self.engine } }
    func applicationDidFinishLaunching(_ n: Notification) {
        MainActor.assumeIsolated { Self.engine.start() }
        if let dir = ProcessInfo.processInfo.environment["CMC_SNAPSHOT_DIR"] { DevSnapshots.run(dir: dir) }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ n: Notification) { MainActor.assumeIsolated { engine?.stopSync() } }
}

@main
struct CMCApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var engine = AppDelegate.engine
    @StateObject private var web = WebHost.shared
    @State private var showKeys = false
    private let releasesURL = URL(string: "https://github.com/parabolicdapps/clonemycontracts/releases")!

    var body: some Scene {
        WindowGroup("CloneMyContracts", id: "main") {
            ContentView()
                .environmentObject(engine).environmentObject(web)
                .sheet(isPresented: $showKeys) { APIKeysSheet().environmentObject(engine) }
                
                .onReceive(NotificationCenter.default.publisher(for: .keysChanged)) { _ in web.reload() }
        }
        .commands {
            CommandGroup(replacing: .appSettings) {
                Button("Settings...") { web.openSettings() }.keyboardShortcut(",")
                Button("API Keys...") { showKeys = true }
            }
            CommandGroup(after: .appInfo) {
                Button("Check for Updates...") { NSWorkspace.shared.open(releasesURL) }
            }
            CommandGroup(replacing: .newItem) {}
            CommandMenu("Engine") {
                Button("Show Engine Log") { NotificationCenter.default.post(name: .showEngineLog, object: nil) }.keyboardShortcut("l", modifiers: [.command, .shift])
                Button("Restart Engine") { engine.restart() }
                Button("Welcome and Container Check...") { NotificationCenter.default.post(name: .showWelcome, object: nil) }
            }
        }
        Window("Engine Log", id: "log") { EngineLogView().environmentObject(engine) }
    }
}


/// Development aid: with CMC_SNAPSHOT_DIR set, writes PNGs of the app window (rendered in-process, so it works with the screen locked).
enum DevSnapshots {
    static func run(dir: String) {
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 14) {
            let js = "const r = await fetch('/api/chains'); const j = await r.json(); return JSON.stringify({status: r.status, chains: j.chains.length, title: document.title, settingsBtn: !!document.getElementById('open-settings')})"
            WebHost.shared.webView.callAsyncJavaScript(js, in: nil, in: .page) { res in
                let out: String; if case .success(let v) = res { out = "\(v ?? "nil")" } else if case .failure(let e) = res { out = "error \(e)" } else { out = "?" }
                try? out.write(toFile: dir + "/web-api-check.txt", atomically: true, encoding: .utf8)
                WebHost.shared.openSettings()
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                WebHost.shared.webView.takeSnapshot(with: nil) { img, _ in
                    guard let img, let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { return }
                    try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: dir + "/webview.png"))
                }
            }
        }
        for (i, delay) in [4.0, 12.0].enumerated() {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                for (j, w) in NSApp.windows.enumerated() {
                    guard let v = w.contentView?.superview ?? w.contentView, v.bounds.width > 100,
                          let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { continue }
                    v.cacheDisplay(in: v.bounds, to: rep)
                    try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: "\(dir)/snap\(i)-win\(j).png"))
                }
            }
        }
    }
}
