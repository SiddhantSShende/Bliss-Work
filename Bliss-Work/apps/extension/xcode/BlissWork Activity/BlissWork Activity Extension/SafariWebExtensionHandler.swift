import SafariServices
import os.log

/// The standard `safari-web-extension-converter` boilerplate: Safari routes
/// native-messaging calls (`browser.runtime.sendNativeMessage` /
/// `nativeMessaging` API surface) through this class. This extension never
/// uses native messaging — every call the bundled `background.js` makes is
/// `chrome.tabs`/`chrome.storage`/`chrome.alarms`/`chrome.idle` (handled by
/// Safari's WebExtension runtime itself) plus a plain `fetch()` straight to
/// `POST /telemetry/ingest/agent` (needs the network-client entitlement, see
/// this target's own `.entitlements` file, not native messaging). This
/// handler exists only because `NSExtensionPrincipalClass` in Info.plist
/// requires SOME class conforming to `NSExtensionRequestHandling` — Apple's
/// own template leaves it in as a no-op stub for exactly this case, and this
/// file does the same rather than removing a class the extension point
/// requires.
class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let profile: UUID?
        if #available(macOS 11.0, iOS 17.0, *) {
            profile = request?.userInfo?[SFExtensionProfileKey] as? UUID
        } else {
            profile = request?.userInfo?["profile"] as? UUID
        }

        let message = request?.userInfo?[SFExtensionMessageKey]

        os_log(.default, "Received message from browser.runtime.sendNativeMessage: %@ (profile: %@)",
               String(describing: message), profile?.uuidString ?? "none")

        let responseItem = NSExtensionItem()
        if #available(macOS 11.0, iOS 17.0, *) {
            responseItem.userInfo = [SFExtensionMessageKey: ["echo": message ?? [:]]]
        } else {
            responseItem.userInfo = ["message": ["echo": message ?? [:]]]
        }
        context.completeRequest(returningItems: [responseItem], completionHandler: nil)
    }
}
