package com.mayank2109.blissworkmobile

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Finishes the current task outright, removing it from Android Recents.
 *
 * Exactly one caller: QuickActionHost.tsx, when a launcher shortcut
 * (android/app/src/main/res/xml/shortcuts.xml — Chats/Channels/Tasks) is
 * tapped while BlissWork is fully closed. That intent has no running task to
 * join, so Android creates a brand-new one with `autoRemoveRecents=false` —
 * its baseIntent is the shortcut's own ACTION_VIEW `blisswork://quick/...`
 * intent, not the launcher's ACTION_MAIN one, and Android only auto-cleans a
 * task started the latter way. A plain finish() (or moveTaskToBack(), the
 * pre-S "return to launcher" behaviour MainActivity.invokeDefaultOnBackPressed
 * already special-cases) leaves that now-empty task sitting in Recents
 * forever as a blank "ghost" card — reproduced directly against a running
 * emulator: `dumpsys activity recents` showed it as a SEPARATE Task record
 * (`type=undefined`, distinct from the app's real, standard-type task) once
 * its one Activity had finished. finishAndRemoveTask() is the documented API
 * for removing a task immediately regardless of that flag.
 *
 * NEVER called when the task might hold real navigation state (the app was
 * already open) — see quickActionStore.hasShownNormalApp() and the guard in
 * QuickActionHost.finish(). Removing an ordinary, in-use app task would take
 * the user's whole app (and its Recents entry) down with it.
 */
class QuickActionTaskModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName(): String = "QuickActionTask"

  @ReactMethod
  fun finishAndRemoveTask(promise: Promise) {
    val activity = ctx.currentActivity
    if (activity == null) {
      promise.resolve(false)
      return
    }
    activity.runOnUiThread {
      try {
        promise.resolve(activity.finishAndRemoveTask())
      } catch (e: Exception) {
        promise.resolve(false)
      }
    }
  }
}
