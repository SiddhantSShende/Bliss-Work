import { useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ApiError } from '@taskboard/shared';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { useSession } from '@taskboard/app/store/session';
import { syncRefreshTokenFromJar } from '../../services/authCookie';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';
import { spacing } from '../../constants/theme';
import type { AuthStackParamList } from '../../navigation/types';
import { useThemeColors } from '../../theme/ThemeProvider';
import { AuthScreenLayout } from './AuthScreenLayout';

type Props = NativeStackScreenProps<AuthStackParamList, 'MfaChallenge'>;

/**
 * Reached from LoginScreen when a second factor is still owed. Mirrors
 * packages/app/src/routes/MfaChallenge.tsx's ChallengeForm (TOTP code /
 * backup code). Two things that screen also handles are deliberately out of
 * scope here rather than half-built:
 *
 *  - WebAuthn/passkey step-up ("Use a passkey instead") — needs a native
 *    module (react-native-passkey) not yet added; tracked for Phase F.
 *  - `enrollmentRequired` (a workspace that mandates MFA for an admin who
 *    hasn't enrolled yet) — needs the QR-enrollment + backup-codes-reveal
 *    UI (TotpEnrollPanel/BackupCodesView), real screens of their own, not
 *    a corner of this one. Shown as a clear message instead of a broken
 *    form; also tracked for Phase F.
 */
export function MfaChallengeScreen({ route }: Props) {
  const colors = useThemeColors();
  const { pendingToken, enrollmentRequired } = route.params;
  const { api } = useRuntime();
  const setSession = useSession((s) => s.setSession);
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  if (enrollmentRequired) {
    return (
      <AuthScreenLayout title="Two-factor setup required">
        <Text style={{ color: colors.muted, fontSize: 14, textAlign: 'center' }}>
          Your workspace requires two-factor authentication, and this account hasn't set it up yet.
          Please finish setup from the BlissWork web app, then sign in here again.
        </Text>
      </AuthScreenLayout>
    );
  }

  const submit = async () => {
    if (code.length < 4 || busy) return;
    setBusy(true);
    try {
      const session = await api.mfaChallengeVerify(
        useBackupCode ? { pendingToken, backupCode: code } : { pendingToken, totpCode: code },
      );
      await syncRefreshTokenFromJar();
      setSession({ user: session.user, accessToken: session.accessToken, expiresIn: session.expiresIn });
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        Alert.alert('Too many attempts', 'Wait a minute before trying again.');
      } else {
        Alert.alert(useBackupCode ? 'Incorrect backup code' : 'Incorrect code');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthScreenLayout
      title="Two-factor authentication"
      subtitle={useBackupCode ? 'Enter one of your backup codes.' : 'Enter the code from your authenticator app.'}
    >
      <TextField
        label={useBackupCode ? 'Backup code' : 'Authentication code'}
        value={code}
        onChangeText={setCode}
        placeholder={useBackupCode ? 'xxxxx-xxxxx' : '123456'}
        keyboardType={useBackupCode ? 'default' : 'number-pad'}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={useBackupCode ? 32 : 10}
        textContentType="oneTimeCode"
        autoFocus
      />
      <Button title={busy ? 'Verifying…' : 'Verify'} onPress={submit} loading={busy} disabled={code.length < 4} />
      <View style={{ alignItems: 'center', gap: spacing.xs }}>
        <Pressable
          onPress={() => {
            setUseBackupCode((v) => !v);
            setCode('');
          }}
        >
          <Text style={{ color: colors.accent, fontSize: 14, fontWeight: '600' }}>
            {useBackupCode ? 'Use an authentication code instead' : 'Use a backup code instead'}
          </Text>
        </Pressable>
      </View>
    </AuthScreenLayout>
  );
}
