import './src/polyfills';
import { registerGlobals } from '@livekit/react-native';
import { registerRootComponent } from 'expo';
import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import { NativeModules } from 'react-native';
import App from './App';

// Installs RTCPeerConnection / mediaDevices / MediaStream (react-native-webrtc)
// and the LiveKit polyfills. Must run before any call code executes.
registerGlobals();

const BACKGROUND_NOTIFICATION_TASK = 'BACKGROUND-NOTIFICATION-TASK';

TaskManager.defineTask(BACKGROUND_NOTIFICATION_TASK, ({ data, error, executionInfo }) => {
  if (error) {
    console.error("Background notification task error:", error);
    return;
  }
  if (data) {
    const { notification } = data;
    if (notification && notification.request && notification.request.trigger && notification.request.trigger.type === 'push') {
      const payload = notification.request.trigger.remoteMessage?.data;
      if (payload && payload.type === 'call.invite') {
        const { IncomingCall } = NativeModules;
        if (IncomingCall) {
          IncomingCall.show(
            payload.callId || 'unknown',
            payload.callerName || 'Someone',
            payload.isVideo === 'true' || payload.isVideo === true ? 'video' : 'audio',
            'direct', // or 'channel'
            'BlissWork'
          );
        }
      }
    }
  }
});

Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK);
 
// Expo ka entry point
registerRootComponent(App);