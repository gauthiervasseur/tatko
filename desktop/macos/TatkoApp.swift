// Tatko for macOS: a native window around the offline web app.
//
// The web app ships inside the bundle at Contents/Resources/app/ and is
// loaded from disk, so the Mac app works offline like the browser version.
// This file only adds what a bare WKWebView lacks: a file picker for
// <input type=file>, Save dialogs for exports, a menu bar, and window state.
//
// Build: tools/build.py (compiles a universal arm64 + x86_64 binary).

import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate, WKDownloadDelegate {
    private var window: NSWindow!
    private var web: WKWebView!

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()          // keeps layouts & theme between launches
        web = WKWebView(frame: .zero, configuration: config)
        web.uiDelegate = self
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground") // no white flash before the page paints

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "Tatko"
        window.backgroundColor = NSColor(red: 0.043, green: 0.024, blue: 0.125, alpha: 1) // #0b0620
        window.minSize = NSSize(width: 900, height: 600)
        window.contentView = web
        window.center()
        window.setFrameAutosaveName("TatkoMainWindow")
        window.makeKeyAndOrderFront(nil)

        let appDir = Bundle.main.resourceURL!.appendingPathComponent("app", isDirectory: true)
        var page = appDir.appendingPathComponent("index.html")
        if selfTestDir != nil, let u = URL(string: page.absoluteString + "#mute&nocrt&demo&preset=table") { page = u }
        web.loadFileURL(page, allowingReadAccessTo: appDir)
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: - Self-test (build verification only)
    // TATKO_SELFTEST=<dir> loads the demo, writes snapshot.png + checks.json there, then quits.

    private let selfTestDir = ProcessInfo.processInfo.environment["TATKO_SELFTEST"]

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let dir = selfTestDir else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
            let js = """
            JSON.stringify({ plotly: !!window.Plotly, rows: Tatko.App.state.ds ? Tatko.App.state.ds.n : 0,
              table: !!document.querySelector('#viz table.pivot'), broken: /SOMETHING BROKE/.test(document.body.innerText),
              pixelFont: document.fonts.check('12px "Press Start 2P"'), storage: (function(){ try { localStorage.setItem('t','1'); return localStorage.getItem('t') === '1'; } catch (e) { return false; } })() })
            """
            webView.evaluateJavaScript(js) { result, error in
                let out = URL(fileURLWithPath: dir)
                try? ((result as? String) ?? "{\"error\": \"\(String(describing: error))\"}").write(to: out.appendingPathComponent("checks.json"), atomically: true, encoding: .utf8)
                webView.takeSnapshot(with: nil) { image, _ in
                    if let tiff = image?.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                       let png = rep.representation(using: .png, properties: [:]) {
                        try? png.write(to: out.appendingPathComponent("snapshot.png"))
                    }
                    NSApp.terminate(nil)
                }
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // MARK: - Menu bar (Edit menu is what makes Cmd-C / Cmd-V work in text fields)

    private func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Tatko", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Tatko", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Tatko", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let fileItem = NSMenuItem(); main.addItem(fileItem)
        let fileMenu = NSMenu(title: "File")
        fileMenu.addItem(withTitle: "Load CSV…", action: #selector(loadCSV), keyEquivalent: "o")
        fileMenu.addItem(withTitle: "Load Theme CSS…", action: #selector(loadTheme), keyEquivalent: "")
        fileMenu.addItem(.separator())
        fileMenu.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileItem.submenu = fileMenu

        let editItem = NSMenuItem(); main.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu

        let viewItem = NSMenuItem(); main.addItem(viewItem)
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        let fs = viewMenu.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fs.keyEquivalentModifierMask = [.command, .control]
        viewItem.submenu = viewMenu

        let winItem = NSMenuItem(); main.addItem(winItem)
        let winMenu = NSMenu(title: "Window")
        winMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        winMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        winItem.submenu = winMenu
        NSApp.windowsMenu = winMenu

        let helpItem = NSMenuItem(); main.addItem(helpItem)
        let helpMenu = NSMenu(title: "Help")
        helpMenu.addItem(withTitle: "How to Play", action: #selector(showHelp), keyEquivalent: "?")
        helpItem.submenu = helpMenu
        NSApp.helpMenu = helpMenu

        NSApp.mainMenu = main
    }

    // Menu actions reuse the page's own buttons, so behaviour stays identical.
    private func click(_ action: String) {
        web.evaluateJavaScript("document.querySelector('[data-action=\"\(action)\"]').click()", completionHandler: nil)
    }
    @objc private func loadCSV() { click("open-csv") }
    @objc private func loadTheme() { click("open-theme") }
    @objc private func showHelp() { click("help") }
    @objc private func reload() { web.reload() }

    // MARK: - <input type="file">

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.beginSheetModal(for: window) { result in
            completionHandler(result == .OK ? panel.urls : nil)
        }
    }

    // MARK: - Navigation: exports become downloads, web links open in the browser

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 preferences: WKWebpagePreferences,
                 decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void) {
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download, preferences); return
        }
        if let url = navigationAction.request.url, let scheme = url.scheme, ["http", "https", "mailto"].contains(scheme) {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel, preferences); return
        }
        decisionHandler(.allow, preferences)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        panel.beginSheetModal(for: window) { result in
            guard result == .OK, let url = panel.url else { completionHandler(nil); return }
            try? FileManager.default.removeItem(at: url) // the panel already confirmed "Replace"
            completionHandler(url)
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let alert = NSAlert(error: error)
        alert.beginSheetModal(for: window, completionHandler: nil)
    }

    // window.open / target=_blank links: hand them to the default browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    // If the web content process ever crashes, bring the app back instead of a blank window.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
