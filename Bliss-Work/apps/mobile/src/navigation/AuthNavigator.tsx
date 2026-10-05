import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { LoginScreen } from '../screens/auth/LoginScreen';
import { MfaChallengeScreen } from '../screens/auth/MfaChallengeScreen';
import type { AuthStackParamList } from './types';

const Stack = createNativeStackNavigator<AuthStackParamList>();

/** Signed-out surface: Login, and MfaChallenge when a second factor is
 *  still owed. Mirrors packages/app/src/App.tsx's signed-out routes, minus
 *  onboarding/invite/forgot-password/reset-password/verify-email — those
 *  are account-lifecycle flows a phone is a poor fit for entering fresh
 *  (they're link-driven, e.g. an email's reset link) and stay on web for
 *  now; existing accounts sign in here today. */
export function AuthNavigator() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false, animation: 'fade', contentStyle: { backgroundColor: 'transparent' } }}>
      <Stack.Screen name="Login" component={LoginScreen} />
      <Stack.Screen name="MfaChallenge" component={MfaChallengeScreen} />
    </Stack.Navigator>
  );
}
