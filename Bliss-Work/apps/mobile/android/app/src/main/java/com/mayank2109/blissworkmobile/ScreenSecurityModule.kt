package com.mayank2109.blissworkmobile

import android.app.Activity
import android.os.Build
import android.view.WindowManager
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * Screenshot protection for BlissWork's private conversations (chats and channels).
 *
 * JS calls [setProtected] with true while a chat/channel is the screen the user is
 * looking at, and false when they leave it, so the protection follows the screen
 * instead of covering the whole app (meetings, screen sharing, camera and the
 * rest are untouched).
 *
 *  - Blocking: `FLAG_SECURE` on the activity window. The OS refuses screenshots
 *    and screen recording of the window, and shows it black in Recents and to
 *    MediaProjection capture.
 *  - Detection: Android 14+ (API 34) only, via `Activity.ScreenCaptureCallback`
 *    (permission DETECT_SCREEN_CAPTURE). Earlier Android versions expose no
 *    supported screenshot callback, so there the screenshot is still blocked but
 *    no event is emitted. Nothing is faked: [screenshotAttempt] is emitted only
 *    from the OS callback. Whether the OS also calls it for a capture that
 *    FLAG_SECURE blocked is up to the OS/OEM — hence the JS side also treats the
 *    callback as a single, debounced event.
 *  - A photo of the screen from another device cannot be detected or stopped.
 */
class ScreenSecurityModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

  private var callback: Any? = null
  private var callbackActivity: Activity? = null
  private var lastEmitAt = 0L

  override fun getName(): String = "ScreenSecurity"

  @ReactMethod
  fun isDetectionSupported(promise: Promise) = promise.resolve(Build.VERSION.SDK_INT >= 34)

  @ReactMethod
  fun setProtected(on: Boolean) {
    val activity = ctx.currentActivity ?: return
    activity.runOnUiThread {
      if (on) activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
      else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
      if (on) register(activity) else unregister()
    }
  }

  private fun register(activity: Activity) {
    if (Build.VERSION.SDK_INT < 34 || callback != null) return
    try {
      val cb = Activity.ScreenCaptureCallback {
        // One capture can be reported more than once; forward one per 2s window.
        val now = System.currentTimeMillis()
        if (now - lastEmitAt < 2000) return@ScreenCaptureCallback
        lastEmitAt = now
        if (ctx.hasActiveReactInstance()) {
          ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("screenshotAttempt", null)
        }
      }
      activity.registerScreenCaptureCallback(activity.mainExecutor, cb)
      callback = cb
      callbackActivity = activity
    } catch (_: SecurityException) {
      // DETECT_SCREEN_CAPTURE not granted: protection still applies, detection is off.
    }
  }

  private fun unregister() {
    if (Build.VERSION.SDK_INT < 34) return
    val cb = callback as? Activity.ScreenCaptureCallback ?: return
    try {
      callbackActivity?.unregisterScreenCaptureCallback(cb)
    } catch (_: Exception) {
    }
    callback = null
    callbackActivity = null
  }

  @ReactMethod
  fun addListener(eventName: String) {}

  @ReactMethod
  fun removeListeners(count: Int) {}
}
