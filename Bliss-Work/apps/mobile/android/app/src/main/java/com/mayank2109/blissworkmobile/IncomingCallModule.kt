package com.mayank2109.blissworkmobile

import android.app.Activity
import android.app.KeyguardManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import android.util.Log
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.lang.ref.WeakReference

/**
 * The Android half of BlissWork's incoming-call ring.
 *
 * It does NOT replace the call system: signalling, accept and decline all stay
 * in JS (callController / roomController). This module only makes the ring
 * behave like a phone call within what Android allows:
 *
 *  - [show] posts ONE high-priority CATEGORY_CALL notification (call-style
 *    Answer / Decline buttons, looping ringtone) carrying a full-screen intent.
 *    Screen off or locked, Android launches [MainActivity] over the lock screen
 *    and the in-app slide-to-answer ring screen is what the user sees. Device in
 *    use, Android shows it as a heads-up call notification instead.
 *  - Answer opens the app and hands "accept" to JS; Decline is a broadcast that
 *    hands "decline" to JS without opening the app. Both are delivered through
 *    [emit] as `incomingCallAction`, or held for [consumeLaunchAction] if JS was
 *    not up yet.
 *  - [MainActivity] calls [onActivityIntent] so a call launch turns the screen on
 *    and shows over the keyguard; JS calls [releaseLockScreen] once no call is
 *    live so the app never lingers over the lock screen afterwards.
 *  - [startRingtone]/[stopRingtone]: [show]'s own ring (the notification's
 *    FLAG_INSISTENT sound) only plays while the notification is actually
 *    POSTED, which JS deliberately skips while the app is in the foreground —
 *    the in-app ring screen is the UI there, so a second heads-up banner on
 *    top of it would be the exact duplicate this module exists to avoid (see
 *    notifications.ts). That left the foreground case with no sound at all.
 *    These two play/stop just the ring (device ringtone + a synced vibration
 *    pattern, honouring ringer mode via USAGE_NOTIFICATION_RINGTONE) with no
 *    notification attached, so JS can call them for exactly that gap.
 *
 * Limits, on purpose: this cannot ring a phone whose process is dead (that
 * needs a server push — see CALLING.md), and Android 14+ can revoke
 * USE_FULL_SCREEN_INTENT per app ([canUseFullScreenIntent]); without it the
 * call still shows as a heads-up notification.
 */
class IncomingCallModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

  init {
    instance = WeakReference(this)
  }

  override fun getName(): String = "IncomingCall"

  @ReactMethod
  fun show(callId: String, name: String, media: String, kind: String, context: String?) {
    ensureChannel(ctx)
    val video = media == "video"
    val what = if (video) "BlissWork Video Call" else "BlissWork Audio Call"
    val notifId = notificationId(callId)

    // Where the full-screen intent and a body tap land: the app's ring screen.
    val open = activityIntent(ctx, callId, kind, ACTION_OPEN)
    val fullScreen = PendingIntent.getActivity(ctx, notifId, open, PI_FLAGS)
    val answer = PendingIntent.getActivity(ctx, notifId + 1, activityIntent(ctx, callId, kind, ACTION_ACCEPT), PI_FLAGS)
    val decline = PendingIntent.getBroadcast(
      ctx,
      notifId + 2,
      Intent(ctx, IncomingCallReceiver::class.java).apply {
        action = ACTION_DECLINE_BROADCAST
        setPackage(ctx.packageName)
        putExtra(EXTRA_CALL_ID, callId)
        putExtra(EXTRA_KIND, kind)
      },
      PI_FLAGS,
    )

    val caller = Person.Builder().setName(name).setImportant(true).build()
    val b = NotificationCompat.Builder(ctx, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.sym_call_incoming)
      .setContentTitle(name)
      .setContentText(if (context.isNullOrBlank()) what else "$what · $context")
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setOngoing(true)
      .setAutoCancel(false)
      .setOnlyAlertOnce(false)
      .setContentIntent(fullScreen)
      .setFullScreenIntent(fullScreen, true)
      // Safety net: the controllers stop the ring at ~30s and cancel this, but a
      // notification that outlives its call must never keep ringing.
      .setTimeoutAfter(RING_TIMEOUT_MS)
      .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, decline, answer))
      .addPerson(caller)
    // Pre-Android-8 has no channel to carry the ringtone.
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      b.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE))
      b.setVibrate(VIBRATION)
    }
    val n = b.build()
    // Loop the ringtone until the notification is cancelled, like a phone call.
    n.flags = n.flags or android.app.Notification.FLAG_INSISTENT

    val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    nm.notify(TAG, notifId, n)
  }

  @ReactMethod
  fun cancel(callId: String) = cancelNotification(ctx, callId)

  /** Foreground ring: device ringtone + vibration, looping, no notification
   *  attached. Idempotent — a second call while already ringing is a no-op
   *  rather than a second overlapping player. */
  @ReactMethod
  fun startRingtone() {
    if (ringtonePlayer != null) return
    var player: MediaPlayer? = null
    try {
      player = MediaPlayer()
      player.setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
          .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
          .build(),
      )
      player.setDataSource(ctx, RingtoneManager.getActualDefaultRingtoneUri(ctx, RingtoneManager.TYPE_RINGTONE) ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE))
      player.isLooping = true
      player.prepare()
      player.start()
      ringtonePlayer = player
    } catch (e: Exception) {
      // No ringtone set / media source unreadable on this device: ring by
      // vibration alone rather than throwing across the JS bridge.
      Log.w(TAG, "startRingtone: could not play the ringtone", e)
      // The player was constructed before setDataSource/prepare threw: free it.
      try { player?.release() } catch (_: Exception) {}
      ringtonePlayer = null
    }
    startVibration()
  }

  /** The JS runtime is going away (reload / crash). Nothing is left to call
   *  [stopRingtone] when the call ends, and the ring + vibration loop forever
   *  until then — so silence them here. */
  override fun invalidate() {
    stopRingtone()
    super.invalidate()
  }

  /** Stop the foreground ring. Safe to call even if it was never started
   *  (answered from the notification path instead, call ended before it
   *  began, etc.) — every exit from 'ringing' calls this unconditionally. */
  @ReactMethod
  fun stopRingtone() {
    ringtonePlayer?.let {
      try {
        it.stop()
      } catch (_: Exception) {
        // Not prepared/already stopped.
      }
      it.release()
    }
    ringtonePlayer = null
    stopVibration()
  }

  /** Whether Android will let this app take over the screen for a call (API 34+ can revoke it). */
  @ReactMethod
  fun canUseFullScreenIntent(promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      promise.resolve(true)
      return
    }
    val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    promise.resolve(nm.canUseFullScreenIntent())
  }

  /** The system page where the user re-grants full-screen call notifications. */
  @ReactMethod
  fun openFullScreenIntentSettings() {
    val i = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:${ctx.packageName}"))
    } else {
      Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName)
    }
    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      ctx.startActivity(i)
    } catch (_: Exception) {
      // No settings screen to open on this device.
    }
  }

  /** Stop showing over the lock screen / holding the screen on. Idempotent. */
  @ReactMethod
  fun releaseLockScreen() {
    val activity = ctx.currentActivity ?: return
    activity.runOnUiThread { setShowOverLockScreen(activity, false) }
  }

  /** An action that launched (or arrived before JS was listening), once. */
  @ReactMethod
  fun consumeLaunchAction(promise: Promise) {
    val p = pending
    pending = null
    if (p == null) {
      promise.resolve(null)
      return
    }
    promise.resolve(Arguments.createMap().apply {
      putString("action", p.action)
      putString("callId", p.callId)
      putString("kind", p.kind)
    })
  }

  private fun vibrator(): Vibrator? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      (ctx.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
    } else {
      @Suppress("DEPRECATION")
      ctx.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
    }

  private fun startVibration() {
    val v = vibrator() ?: return
    if (!v.hasVibrator()) return
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        v.vibrate(VibrationEffect.createWaveform(VIBRATION, 0))
      } else {
        @Suppress("DEPRECATION")
        v.vibrate(VIBRATION, 0)
      }
    } catch (e: Exception) {
      Log.w(TAG, "startVibration failed", e)
    }
  }

  private fun stopVibration() {
    vibrator()?.cancel()
  }

  @ReactMethod
  fun addListener(eventName: String) {}

  @ReactMethod
  fun removeListeners(count: Double) {}

  companion object {
    private const val TAG = "blisswork.incoming_call"
    // A new channel id: channel sound/importance are frozen once created, and
    // the old expo-notifications channel ("incoming-calls") was made without a looping ringtone.
    private const val CHANNEL_ID = "incoming-calls-ring"
    private const val RING_TIMEOUT_MS = 60_000L
    private val VIBRATION = longArrayOf(0, 700, 500, 700)
    private val PI_FLAGS = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

    const val EXTRA_CALL_ID = "blisswork.incomingCall.callId"
    const val EXTRA_KIND = "blisswork.incomingCall.kind"
    const val EXTRA_ACTION = "blisswork.incomingCall.action"
    const val ACTION_OPEN = "open"
    const val ACTION_ACCEPT = "accept"
    const val ACTION_DECLINE = "decline"
    const val ACTION_DECLINE_BROADCAST = "com.mayank2109.blissworkmobile.INCOMING_CALL_DECLINE"

    private class Pending(val action: String, val callId: String, val kind: String)

    @Volatile private var pending: Pending? = null
    private var instance: WeakReference<IncomingCallModule>? = null
    @Volatile private var lockScreenApplied = false
    @Volatile private var ringtonePlayer: MediaPlayer? = null

    private fun notificationId(callId: String): Int = (callId.hashCode() and 0x0fffffff) * 4

    private fun activityIntent(ctx: Context, callId: String, kind: String, action: String) =
      Intent(ctx, MainActivity::class.java).apply {
        // singleTask + these flags brings the existing task forward rather than starting a second one.
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        // A per-action data URI keeps the three PendingIntents distinct.
        data = Uri.parse("blisswork-call://$action/$callId")
        putExtra(EXTRA_CALL_ID, callId)
        putExtra(EXTRA_KIND, kind)
        putExtra(EXTRA_ACTION, action)
      }

    private fun ensureChannel(ctx: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (nm.getNotificationChannel(CHANNEL_ID) != null) return
      val ch = NotificationChannel(CHANNEL_ID, "Incoming call ring", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "Rings like a phone call when someone calls you in BlissWork"
        lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
        enableVibration(true)
        vibrationPattern = VIBRATION
        setSound(
          RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build(),
        )
      }
      nm.createNotificationChannel(ch)
    }

    @JvmStatic
    fun cancelNotification(ctx: Context, callId: String) {
      val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      nm.cancel(TAG, notificationId(callId))
    }

    /** Deliver an action to JS now, or hold it for [consumeLaunchAction]. */
    private fun deliver(action: String, callId: String, kind: String) {
      val m = instance?.get()
      if (m != null && m.ctx.hasActiveReactInstance()) {
        val map = Arguments.createMap().apply {
          putString("action", action)
          putString("callId", callId)
          putString("kind", kind)
        }
        m.ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("incomingCallAction", map)
        pending = null
      } else {
        pending = Pending(action, callId, kind)
      }
    }

    /** Decline tapped on the notification: no UI, JS answers the caller. */
    @JvmStatic
    fun onDeclineBroadcast(ctx: Context, intent: Intent) {
      val callId = intent.getStringExtra(EXTRA_CALL_ID) ?: return
      cancelNotification(ctx, callId)
      deliver(ACTION_DECLINE, callId, intent.getStringExtra(EXTRA_KIND) ?: "direct")
    }

    /** From MainActivity.onCreate / onNewIntent: a call launched (or answered from) the notification. */
    @JvmStatic
    fun onActivityIntent(activity: Activity, intent: Intent?) {
      val callId = intent?.getStringExtra(EXTRA_CALL_ID) ?: return
      val action = intent.getStringExtra(EXTRA_ACTION) ?: ACTION_OPEN
      val kind = intent.getStringExtra(EXTRA_KIND) ?: "direct"
      // Handle each launch once: the same intent is redelivered on recreation.
      intent.removeExtra(EXTRA_CALL_ID)
      setShowOverLockScreen(activity, true)
      // Answering silences the ring immediately; 'open' keeps ringing until the
      // call controller says the ring is over.
      if (action == ACTION_ACCEPT) cancelNotification(activity, callId)
      deliver(action, callId, kind)
    }

    @JvmStatic
    fun setShowOverLockScreen(activity: Activity, on: Boolean) {
      if (!on && !lockScreenApplied) return
      lockScreenApplied = on
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
        activity.setShowWhenLocked(on)
        activity.setTurnScreenOn(on)
      } else {
        val f = WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
          WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
          WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
        if (on) activity.window.addFlags(f) else activity.window.clearFlags(f)
      }
      if (on && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        // Ask (never force) the keyguard away so Answer lands on a usable call
        // screen; a secure lock screen still requires the user to unlock.
        val km = activity.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
        if (km?.isKeyguardLocked == true && !km.isKeyguardSecure) km.requestDismissKeyguard(activity, null)
      }
    }
  }
}
