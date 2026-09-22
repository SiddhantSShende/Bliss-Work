import { useState } from 'react';
import { Alert, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ApiError, isCaptchaExemptPlatform, isMfaPending } from '@taskboard/shared';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { useSession } from '@taskboard/app/store/session';
import { useCaptcha } from '../../hooks/useCaptcha';
import { clientPlatform } from '../../lib/clientPlatform';
import { syncRefreshTokenFromJar } from '../../services/authCookie';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';
import { CaptchaField } from '../../components/CaptchaField';
import type { AuthStackParamList } from '../../navigation/types';
import { useThemeColors } from '../../theme/ThemeProvider';
import { AuthScreenLayout } from './AuthScreenLayout';

type Props = NativeStackScreenProps<AuthStackParamList, 'Login'>;

export function LoginScreen({ navigation }: Props) {
  const colors = useThemeColors();
  const { api } = useRuntime();
  const setSession = useSession((s) => s.setSession);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // iOS signs in without a CAPTCHA; Android keeps it. The server makes the same
  // call from `clientPlatform` — this only decides whether to fetch and show it.
  // `captchaForced` covers a server that wants one anyway (client and server out
  // of step, e.g. mid-deploy): show the challenge instead of a dead end.
  const [captchaForced, setCaptchaForced] = useState(false);
  const needsCaptcha = captchaForced || !isCaptchaExemptPlatform(clientPlatform);
  const captcha = useCaptcha(needsCaptcha);

  const submit = async () => {
    const captchaId = needsCaptcha ? captcha.captchaId : null;
    if ((needsCaptcha && !captchaId) || busy) return;
    setBusy(true);
    try {
      const result = await api.login({
        email,
        password,
        clientPlatform,
        ...(captchaId ? { captchaId, captchaValue: captcha.value } : {}),
      });
      if (isMfaPending(result)) {
        navigation.navigate('MfaChallenge', {
          pendingToken: result.pendingToken,
          methods: result.methods,
          enrollmentRequired: result.enrollmentRequired,
        });
        return;
      }
      // The login response never carries the refresh token (it travels only
      // as an HttpOnly Set-Cookie) — mirror what the native jar just
      // received into the Keychain now, before any screen needs it. See
      // services/authCookie.ts's own doc comment.
      await syncRefreshTokenFromJar();
      setSession({ user: result.user, accessToken: result.accessToken, expiresIn: result.expiresIn });
    } catch (err) {
      // Mirrors packages/app/src/routes/Login.tsx's catch block: only a 401
      // is actually about the credentials, so every other failure gets its
      // own message instead of sending someone to re-type a password that
      // was never the problem.
      if (err instanceof ApiError && err.status === 401) {
        Alert.alert('Invalid email or password');
      } else if (err instanceof ApiError && err.status === 400 && !needsCaptcha) {
        setCaptchaForced(true);
        Alert.alert('Security check required', 'Complete the security check, then sign in again.');
      } else if (err instanceof ApiError && err.status === 400) {
        Alert.alert('Incorrect security check', 'Please try again.');
      } else if (err instanceof ApiError && err.status === 429) {
        Alert.alert('Too many attempts', 'Wait a minute before trying again.');
      } else if (err instanceof ApiError) {
        Alert.alert('Sign-in failed', `The server returned ${err.status}. Your details were not the problem.`);
      } else {
        Alert.alert("Can't reach the server", 'Check your connection and try again.');
      }
      // The CAPTCHA the server just validated is single-use regardless of
      // why the request ultimately failed — a retry needs a fresh one. (Nothing
      // to refresh when none was used; a forced one is fetched by useCaptcha.)
      if (needsCaptcha) void captcha.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthScreenLayout title="Welcome back" subtitle="Sign in to your workspace.">
      <TextField
        label="Email"
        value={email}
        onChangeText={setEmail}
        placeholder="you@acme.com"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        textContentType="emailAddress"
        autoComplete="email"
      />
      <TextField
        label="Password"
        value={password}
        onChangeText={setPassword}
        placeholder="••••••••"
        secureTextEntry
        textContentType="password"
        autoComplete="password"
      />
      {needsCaptcha && <CaptchaField captcha={captcha} />}
      <Button
        title={busy ? 'Signing in…' : 'Sign in'}
        onPress={submit}
        loading={busy}
        disabled={(needsCaptcha && (!captcha.captchaId || captcha.value.length === 0)) || !email || !password}
      />
      <View style={{ alignItems: 'center' }}>
        <Text style={{ color: colors.muted, fontSize: 13 }}>
          Need a workspace? Create one from the BlissWork web app.
        </Text>
      </View>
    </AuthScreenLayout>
  );
}
