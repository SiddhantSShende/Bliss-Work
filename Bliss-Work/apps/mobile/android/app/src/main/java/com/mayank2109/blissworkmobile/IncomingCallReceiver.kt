package com.mayank2109.blissworkmobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Decline on the incoming-call notification: handled without opening the app. */
class IncomingCallReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == IncomingCallModule.ACTION_DECLINE_BROADCAST) {
      IncomingCallModule.onDeclineBroadcast(context, intent)
    }
  }
}
