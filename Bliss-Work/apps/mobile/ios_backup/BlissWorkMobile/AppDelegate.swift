import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider
import ExpoModulesCore

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    window = UIWindow(frame: UIScreen.main.bounds)

    factory.startReactNative(
      withModuleName: "BlissWorkMobile",
      in: window,
      launchOptions: launchOptions
    )

    // Forwards to every autolinked Expo module's ExpoAppDelegateSubscriber —
    // e.g. expo-quick-actions, which reads launchOptions[.shortcutItem] here
    // to capture a cold-start Quick Action tap. Subscribers are registered
    // automatically at process load (expo/ios/AppDelegates/EXAppDelegatesLoader.m),
    // but only get these UIApplicationDelegate calls if something forwards
    // them — normally ExpoAppDelegate does that, but this app's own
    // AppDelegate doesn't subclass it, so we forward explicitly instead.
    _ = ExpoAppDelegateSubscriberManager.application(application, didFinishLaunchingWithOptions: launchOptions)

    return true
  }

  // Warm-start Quick Action tap (app already running, foreground or
  // suspended in background) — same subscriber-forwarding rationale as above.
  func application(
    _ application: UIApplication,
    performActionFor shortcutItem: UIApplicationShortcutItem,
    completionHandler: @escaping (Bool) -> Void
  ) {
    ExpoAppDelegateSubscriberManager.application(application, performActionFor: shortcutItem, completionHandler: completionHandler)
  }

  // blisswork:// deep links (React Navigation's `linking` config, via RN's
  // core Linking module) while the app is already running.
  func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return RCTLinkingManager.application(app, open: url, options: options)
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
