import SwiftUI

enum Defaults {
    /// Bump to show the first-run notice again after it changes.
    static let firstRunVersion = 1
    static let key = "firstRunAcceptedVersion"
}

struct ContentView: View {
    @EnvironmentObject var engine: EngineController
    @EnvironmentObject var web: WebHost
    @AppStorage(Defaults.key) private var accepted = 0
    @Environment(\.openWindow) private var openWindow
    @State private var showWelcome = false
    @State private var loadedGeneration = -1

    var body: some View {
        ZStack {
            WebViewRepresentable(host: web)
            switch engine.state {
            case .running: EmptyView()
            case .stopped, .starting:
                VStack(spacing: 12) { ProgressView(); Text("Starting the engine...").foregroundStyle(.secondary) }
                    .frame(maxWidth: .infinity, maxHeight: .infinity).background(.background)
            case .failed(let msg):
                VStack(spacing: 12) {
                    Image(systemName: "exclamationmark.triangle").font(.largeTitle)
                    Text(msg).multilineTextAlignment(.center).frame(maxWidth: 480)
                    HStack { Button("Show engine log") { NotificationCenter.default.post(name: .showEngineLog, object: nil) }
                             Button("Restart engine") { engine.restart() } }
                }.padding().frame(maxWidth: .infinity, maxHeight: .infinity).background(.background)
            }
        }
        .frame(minWidth: 900, minHeight: 600)
        .sheet(isPresented: $showWelcome) { FirstRunSheet(accepted: $accepted, isPresented: $showWelcome) }
        .onAppear { if accepted < Defaults.firstRunVersion { showWelcome = true } }
        .onReceive(NotificationCenter.default.publisher(for: .showWelcome)) { _ in showWelcome = true }
        .onReceive(NotificationCenter.default.publisher(for: .showEngineLog)) { _ in openWindow(id: "log") }
        .onChange(of: engine.generation) { _, g in Task { await signIn(g) } }
        .task { await signIn(engine.generation) }
    }

    private func signIn(_ g: Int) async {
        guard g > 0, g != loadedGeneration, let url = await engine.signInURL() else { return }
        loadedGeneration = g
        web.signIn(url: url)
    }
}

extension Notification.Name {
    static let showEngineLog = Notification.Name("cmc.showEngineLog")
    static let showWelcome = Notification.Name("cmc.showWelcome")
}

struct FirstRunSheet: View {
    @Binding var accepted: Int
    @Binding var isPresented: Bool
    @State private var runtime: RuntimeStatus = .checking

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Welcome to CloneMyContracts").font(.title2.bold())
            Group {
                Label("This is an unaudited starting point. Review every result before you rely on it or deploy anything. Nothing here is advice.", systemImage: "exclamationmark.shield")
                Label("You are responsible for the licences of the contracts you clone. Many are not open source.", systemImage: "doc.text")
                Label("Everything runs on this Mac. Your API keys stay in the macOS Keychain and are only sent to the AI provider you choose.", systemImage: "lock")
            }.fixedSize(horizontal: false, vertical: true)
            Divider()
            Text("Container runtime").font(.headline)
            Text("Compiling for Solana, CosmWasm, Aptos and Tezos runs in containers. EVM cloning works without one.").font(.callout).foregroundStyle(.secondary)
            runtimeRow
            HStack {
                Button("Check again") { Task { await recheck() } }
                Link("Docker Desktop", destination: URL(string: "https://www.docker.com/products/docker-desktop/")!)
                Link("OrbStack", destination: URL(string: "https://orbstack.dev/download")!)
                Link("Colima", destination: URL(string: "https://github.com/abiosoft/colima#installation")!)
            }
            HStack { Spacer(); Button("I understand, continue") { accepted = Defaults.firstRunVersion; isPresented = false }.keyboardShortcut(.defaultAction) }
        }
        .padding(24).frame(width: 560)
        .task { await recheck() }
    }

    @ViewBuilder private var runtimeRow: some View {
        switch runtime {
        case .checking: HStack { ProgressView().controlSize(.small); Text("Checking...") }
        case .notInstalled: Label("Not installed. Install one of the options below.", systemImage: "xmark.circle").foregroundStyle(.orange)
        case .installedNotRunning(let n): Label("\(n) is installed but not running. Start it, then check again.", systemImage: "pause.circle").foregroundStyle(.orange)
        case .ready(let n): Label("Ready (\(n)).", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
        }
    }
    private func recheck() async { runtime = .checking; runtime = await RuntimeProbe.check() }
}

struct EngineLogView: View {
    @EnvironmentObject var engine: EngineController
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 1) {
                    ForEach(Array(engine.logLines.enumerated()), id: \.offset) { i, l in
                        Text(l).font(.system(.caption, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).id(i)
                    }
                }.padding(8)
            }
            .onChange(of: engine.logLines.count) { _, n in if n > 0 { proxy.scrollTo(n - 1, anchor: .bottom) } }
        }
        .frame(minWidth: 640, minHeight: 360)
    }
}

struct APIKeysSheet: View {
    @EnvironmentObject var engine: EngineController
    @Environment(\.dismiss) private var dismiss
    // ids as in packages/translate PROVIDERS; the secret id is "provider:<id>"
    static let providers: [(id: String, label: String)] = [("openai", "OpenAI"), ("anthropic", "Anthropic"), ("gemini", "Google Gemini"), ("openrouter", "OpenRouter")]
    @State private var values: [String: String] = [:]
    @State private var saved: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("API keys").font(.title3.bold())
            Text("Stored in the macOS Keychain. The running engine receives a changed key straight away; nothing is written to disk by the engine.").font(.callout).foregroundStyle(.secondary)
            ForEach(Self.providers, id: \.id) { p in
                HStack {
                    Text(p.label).frame(width: 120, alignment: .leading)
                    SecureField(saved.contains(p.id) ? "saved (type to replace)" : "key", text: Binding(get: { values[p.id] ?? "" }, set: { values[p.id] = $0 }))
                    Button("Save") { save(p.id) }.disabled((values[p.id] ?? "").isEmpty)
                    Button("Remove") { remove(p.id) }.disabled(!saved.contains(p.id))
                }
            }
            HStack { Spacer(); Button("Done") { dismiss() }.keyboardShortcut(.defaultAction) }
        }
        .padding(20).frame(width: 560)
        .onAppear { let all = Keychain.all(); saved = Set(Self.providers.map(\.id).filter { all["provider:\($0)"] != nil }) }
    }
    private func save(_ id: String) {
        guard let v = values[id], !v.isEmpty, Keychain.set("provider:\(id)", v) else { return }
        engine.pushSecret(id: "provider:\(id)", value: v)
        values[id] = ""; saved.insert(id); web_refresh()
    }
    private func remove(_ id: String) {
        Keychain.delete("provider:\(id)")
        engine.pushSecret(id: "provider:\(id)", value: "") // empty value = no key for this process
        saved.remove(id); web_refresh()
    }
    private func web_refresh() { NotificationCenter.default.post(name: .keysChanged, object: nil) }
}
extension Notification.Name { static let keysChanged = Notification.Name("cmc.keysChanged") }
