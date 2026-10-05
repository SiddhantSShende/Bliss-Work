package com.mayank2109.blissworkmobile

import android.content.Intent
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.view.WindowManager

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

import expo.modules.ReactActivityDelegateWrapper

import com.oney.WebRTCModule.WebRTCModuleOptions

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Set the theme to AppTheme BEFORE onCreate to support
    // coloring the background, status bar, and navigation bar.
    // This is required for expo-splash-screen.
    setTheme(R.style.AppTheme);
    // App-wide screenshot/screen-recording protection, set on the window before
    // ANY screen renders (not a per-screen React call — see ScreenSecurityModule's
    // own doc for why one Activity backs every screen here). Lifted only for the
    // one legitimate exception, a live "share my screen" in a meeting — see
    // ScreenSecurity.setProtected's call sites in roomController.ts — since
    // FLAG_SECURE on this window would otherwise blank that capture too.
    window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    
    val options = WebRTCModuleOptions.getInstance()
    options.enableMediaProjectionService = true
    
    super.onCreate(null)
    // Launched by an incoming-call notification's full-screen intent / Answer button.
    IncomingCallModule.onActivityIntent(this, intent)
  }

  /** The app was already running when a call notification launched it (singleTask). */
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    IncomingCallModule.onActivityIntent(this, intent)
  }

  /**
   * Leaving the app (Home, recents, another app) while a meeting is live shrinks
   * it into Picture-in-Picture instead of backgrounding it, so the call keeps its
   * microphone and connection. Android 12+ does this by itself once armed
   * (setAutoEnterEnabled); this covers Android 8-11. See MeetingPipModule.
   */
  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    MeetingPipModule.enterFromLeaveHint(this)
  }

  /** Tell JS whether it is drawing the full meeting or the small PiP window. */
  override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
    super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
    MeetingPipModule.emit(isInPictureInPictureMode)
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "main"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate {
    return ReactActivityDelegateWrapper(
          this,
          BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
          object : DefaultReactActivityDelegate(
              this,
              mainComponentName,
              fabricEnabled
          ){})
  }

  /**
    * Align the back button behavior with Android S
    * where moving root activities to background instead of finishing activities.
    * @see <a href="https://developer.android.com/reference/android/app/Activity#onBackPressed()">onBackPressed</a>
    */
  override fun invokeDefaultOnBackPressed() {
      if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.R) {
          if (!moveTaskToBack(false)) {
              // For non-root activities, use the default implementation to finish them.
              super.invokeDefaultOnBackPressed()
          }
          return
      }

      // Use the default back button implementation on Android S
      // because it's doing more than [Activity.moveTaskToBack] in fact.
      super.invokeDefaultOnBackPressed()
  }
}
