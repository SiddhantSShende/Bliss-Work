import SwiftUI

/// The container app Safari Web Extensions require — it ships no activity-
/// tracking logic of its own (that is entirely `tracker.ts`/`background.ts`,
/// bundled unmodified into the extension target's `Resources/`, same as every
/// other browser target this repo builds). Its only job is to exist as an
/// installable macOS app so Safari has something to enable the extension
/// through, and to tell the person how.
@main
struct BlissWork_ActivityApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        // A fixed, small window — this is a one-screen "go enable me in
        // Safari" utility, not an app with a UI of its own to grow into. The
        // real settings surface (pair, pause, disconnect) is the extension's
        // own options page (options.html, opened from Safari's toolbar/
        // Settings > Extensions), exactly as it is on every other browser.
        .windowResizability(.contentSize)
    }
}
