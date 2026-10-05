package com.mayank2109.blissworkmobile

import android.app.PictureInPictureParams
import android.content.pm.PackageManager
import android.os.Build
import android.util.Rational
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.lang.ref.WeakReference

/**
 * Android Picture-in-Picture for a live meeting.
 *
 * JS arms it while a meeting is connected ([setArmed]); from then on leaving the
 * app (Home, recents, another app) shrinks the meeting into the system PiP
 * window instead of sending it to the background, so the call keeps its
 * microphone, audio and connection (a backgrounded Android 11+ app loses mic
 * access; a PiP activity is still visible and keeps it).
 *
 *  - Android 12+ (API 31): `setAutoEnterEnabled(true)` — the system enters PiP
 *    on its own when the user leaves.
 *  - Android 8–11: [MainActivity.onUserLeaveHint] calls [enterFromLeaveHint].
 *
 * The activity reports every PiP change back through [emit] so JS can swap the
 * full meeting UI for the compact one and restore it on return.
 */
class MeetingPipModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

  init {
    instance = WeakReference(this)
  }

  override fun getName(): String = "MeetingPip"

  private fun supported(): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
      ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

  @ReactMethod
  fun isSupported(promise: Promise) = promise.resolve(supported())

  /** Arm/disarm auto-PiP. [w]/[h] is the window's aspect ratio (clamped by the OS). */
  @ReactMethod
  fun setArmed(on: Boolean, w: Int, h: Int) {
    armed = on
    if (w > 0 && h > 0) aspect = Rational(w, h)
    if (!supported()) return
    val activity = ctx.currentActivity ?: return
    activity.runOnUiThread {
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          activity.setPictureInPictureParams(buildParams(autoEnter = on))
        } else {
          activity.setPictureInPictureParams(buildParams(autoEnter = false))
        }
      } catch (_: IllegalStateException) {
        // Activity is finishing or PiP is disabled for this device/user.
      }
    }
  }

  /** Enter PiP now (the in-meeting "Picture-in-picture" action). */
  @ReactMethod
  fun enter(promise: Promise) {
    val activity = ctx.currentActivity
    if (!supported() || activity == null) {
      promise.resolve(false)
      return
    }
    activity.runOnUiThread {
      try {
        promise.resolve(activity.enterPictureInPictureMode(buildParams(autoEnter = false)))
      } catch (e: IllegalStateException) {
        promise.resolve(false)
      }
    }
  }

  @ReactMethod
  fun addListener(eventName: String) {}

  @ReactMethod
  fun removeListeners(count: Double) {}

  companion object {
    @Volatile var armed: Boolean = false
    @Volatile var aspect: Rational = Rational(9, 16)
    private var instance: WeakReference<MeetingPipModule>? = null

    private fun buildParams(autoEnter: Boolean): PictureInPictureParams {
      val b = PictureInPictureParams.Builder()
      // The OS accepts ratios between 1:2.39 and 2.39:1 only.
      val r = aspect
      val v = r.toDouble()
      if (v in 0.42..2.39) b.setAspectRatio(r)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) b.setAutoEnterEnabled(autoEnter)
      return b.build()
    }

    /** API 26–30: called from MainActivity.onUserLeaveHint while a meeting is live. */
    @JvmStatic
    fun enterFromLeaveHint(activity: android.app.Activity) {
      if (!armed || Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      try {
        activity.enterPictureInPictureMode(buildParams(autoEnter = false))
      } catch (_: IllegalStateException) {
      }
    }

    /** Called from MainActivity.onPictureInPictureModeChanged. */
    @JvmStatic
    fun emit(inPip: Boolean) {
      val m = instance?.get() ?: return
      if (!m.ctx.hasActiveReactInstance()) return
      m.ctx
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit("meetingPipChanged", inPip)
    }
  }
}
