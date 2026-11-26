import SwiftUI
import WebKit

/// The single WKWebView for the engine UI, plus the navigation rules around it.
@MainActor
final class WebHost: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    static let shared = WebHost()
    let webView: WKWebView
    private var allowedPort: Int?

    override init() {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .nonPersistent() // the session cookie is per launch; nothing to keep on disk
        webView = WKWebView(frame: .zero, configuration: cfg)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
    }

    /// Exchange a one-time code for the session cookie and land on /.
    func signIn(url: URL) {
        allowedPort = url.port
        webView.load(URLRequest(url: url))
    }

    func reload() { webView.reload() }

    /// The Settings screen is a dialog in the web UI (button #open-settings); there is no settings URL.
    func openSettings() {
        webView.evaluateJavaScript("document.getElementById('open-settings')?.click()", completionHandler: nil)
    }

    private func isEngine(_ url: URL?) -> Bool {
        guard let u = url, let port = allowedPort else { return false }
        return u.scheme == "http" && (u.host == "127.0.0.1" || u.host == "localhost") && u.port == port
    }

    // Anything that is not the engine opens in the default browser; the window never navigates away.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload { decisionHandler(.download); return }
        if isEngine(action.request.url) || action.request.url?.scheme == "about" || action.request.url?.scheme == "blob" { decisionHandler(.allow); return }
        if let u = action.request.url, ["http", "https", "mailto"].contains(u.scheme ?? "") { NSWorkspace.shared.open(u) }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if !response.canShowMIMEType || (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")?.lowercased().contains("attachment") == true {
            decisionHandler(.download)
        } else { decisionHandler(.allow) }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        completionHandler(panel.runModal() == .OK ? panel.url : nil)
    }

    // target=_blank links go to the browser
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let u = action.request.url { NSWorkspace.shared.open(u) }
        return nil
    }

    // <input type=file>
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        completionHandler(panel.runModal() == .OK ? panel.urls : nil)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = message; a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        completionHandler(a.runModal() == .alertFirstButtonReturn)
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = message; a.runModal(); completionHandler()
    }
}

struct WebViewRepresentable: NSViewRepresentable {
    let host: WebHost
    func makeNSView(context: Context) -> WKWebView { host.webView }
    func updateNSView(_ v: WKWebView, context: Context) {}
}
