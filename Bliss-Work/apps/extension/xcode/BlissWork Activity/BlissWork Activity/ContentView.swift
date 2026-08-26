import SwiftUI
import SafariServices

/// One screen: confirm the extension is enabled, and if not, say exactly
/// where to go. `SFSafariExtensionManager` can report enabled/disabled state
/// on newer macOS versions, but the state-change notification a container app
/// receives is deliberately limited (Safari does not let an app poll this
/// freely, for the same privacy reasons it does not let a web page detect
/// installed extensions) — so this reads state once, on appear, rather than
/// promising a live-updating badge it cannot actually provide.
struct ContentView: View {
    private let extensionBundleIdentifier = "com.blisswork.activity.extension"

    @State private var statusText = "Checking…"

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "clock.badge.checkmark")
                .font(.system(size: 40))
                .foregroundStyle(.secondary)

            Text("BlissWork Activity")
                .font(.title2).bold()

            Text(statusText)
                .font(.body)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)

            Button("Open Safari Extension Settings") {
                SFSafariApplication.showPreferencesForExtension(
                    withIdentifier: extensionBundleIdentifier
                ) { error in
                    if let error {
                        // Opening Safari's own settings pane failing is not
                        // this app's fault to explain in detail — the person
                        // can always reach it manually via Safari's menu, and
                        // this print exists only so a developer diagnosing a
                        // report has something to look at.
                        print("Could not open Safari extension preferences: \(error)")
                    }
                }
            }
            .buttonStyle(.borderedProminent)

            Text("Then connect it to your BlissWork workspace from the "
                 + "extension's own settings — the same connection code you'd "
                 + "paste into Chrome, Edge, Brave, or Firefox.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
        }
        .padding(32)
        .frame(width: 380, height: 320)
        .onAppear(perform: refreshStatus)
    }

    private func refreshStatus() {
        SFSafariExtensionManager.getStateOfSafariExtension(
            withIdentifier: extensionBundleIdentifier
        ) { state, error in
            DispatchQueue.main.async {
                if let error {
                    statusText = "Couldn't check the extension's status: \(error.localizedDescription)"
                } else if state?.isEnabled == true {
                    statusText = "The extension is enabled. Open its settings in Safari "
                        + "to connect it to your workspace."
                } else {
                    statusText = "The extension isn't enabled yet. Turn it on in "
                        + "Safari Settings \u{2192} Extensions."
                }
            }
        }
    }
}

#Preview {
    ContentView()
}
