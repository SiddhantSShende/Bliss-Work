package com.mayank2109.blissworkmobile

import android.app.Application
import android.content.res.Configuration

import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.ReactPackage
import com.facebook.react.ReactHost
import com.facebook.react.common.ReleaseLevel
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint

import com.oney.WebRTCModule.WebRTCModuleOptions

import expo.modules.ApplicationLifecycleDispatcher
import expo.modules.ExpoReactHostFactory

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    ExpoReactHostFactory.getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Packages that cannot be autolinked yet can be added manually here, for example:
          // add(MyReactNativePackage())
          add(MeetingPipPackage())
          add(ScreenSecurityPackage())
          add(IncomingCallPackage())
          add(QuickActionTaskPackage())
        }
    )
  }

  override fun onCreate() {
    super.onCreate()
    // Screen sharing: Android (10+) only lets an app capture the screen while a
    // foreground service of type mediaProjection is running. react-native-webrtc
    // ships that service (declared in its manifest) but only starts it when this
    // flag is on — it defaults to off, so every Share attempt was refused by the OS.
    // (Deliberately just the flag, not LiveKitReactNative.setup(): that would also
    // swap the audio device module, and call audio already works.)
    WebRTCModuleOptions.getInstance().enableMediaProjectionService = true
    DefaultNewArchitectureEntryPoint.releaseLevel = try {
      ReleaseLevel.valueOf(BuildConfig.REACT_NATIVE_RELEASE_LEVEL.uppercase())
    } catch (e: IllegalArgumentException) {
      ReleaseLevel.STABLE
    }
    loadReactNative(this)
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
  }
}
