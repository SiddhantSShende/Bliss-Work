import { useEffect } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { useSession } from '@taskboard/app/store/session';

export function usePushRegistration() {
  const { api } = useRuntime();
  const authed = useSession((s) => s.status === 'authed');

  useEffect(() => {
    if (!authed) return;

    let isMounted = true;
    
    async function register() {
      try {
        const { status: existingStatus } = await Notifications.getPermissionsAsync();
        let finalStatus = existingStatus;
        if (existingStatus !== 'granted') {
          const { status } = await Notifications.requestPermissionsAsync();
          finalStatus = status;
        }
        if (finalStatus !== 'granted') {
          return; // Permission not granted
        }

        const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
        if (!projectId) {
          console.warn("No Expo Project ID found. Push notifications will not work.");
          return;
        }

        const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
        
        if (isMounted && tokenData.data) {
          // Send to the backend endpoint you're building
          await api.registerDevice(tokenData.data, Platform.OS).catch(e => {
            console.error("Failed to register push token", e);
          });
        }
      } catch (error) {
        console.error("Error registering for push notifications:", error);
      }
    }

    void register();

    return () => {
      isMounted = false;
    };
  }, [authed, api]);
}
