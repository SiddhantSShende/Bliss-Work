import { useMemo, useState } from 'react';
import { ArrowLeft, KeyRound, ShieldCheck, ShieldOff } from 'lucide-react-native';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { useSession } from '@taskboard/app/store/session';
import { ApiError } from '@taskboard/shared';
import { Card } from '../../components/Card';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';
import { radius, spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';
import type { MoreStackParamList } from '../../navigation/types';
import { TotpEnrollPanel } from './TotpEnrollPanel';
import { BackupCodesView } from './BackupCodesView';

type Props = NativeStackScreenProps<MoreStackParamList, 'MfaSettings'>;
type StepUpAction = 'disable' | 'regenerate' | null;

/**
 * Mirrors packages/app/src/routes/MfaSettings.tsx (web): enrolled/
 * not-enrolled branches, TOTP enrollment, backup-code regeneration, turning
 * 2FA off — same `api.mfa*` endpoints. Passkey (WebAuthn) is NOT reproduced
 * here: it needs `navigator.credentials`, a browser API React Native has no
 * equivalent for without a dedicated native passkey module this app doesn't
 * have — every other setting on this page is fully functional.
 */
export function MfaSettingsScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { api } = useRuntime();
  const user = useSession((s) => s.user);
  const setUser = useSession((s) => s.setUser);

  const [enrolling, setEnrolling] = useState(false);
  const [newBackupCodes, setNewBackupCodes] = useState<string[] | null>(null);
  const [stepUpAction, setStepUpAction] = useState<StepUpAction>(null);

  const refreshUser = async () => {
    try {
      setUser(await api.me());
    } catch {
      // The mutating call itself already succeeded — a stale `user` here just
      // means this screen's own branch may lag until the next refetch.
    }
  };

  if (!user) return null;

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={8}>
          <ArrowLeft size={22} color={colors.fg} />
        </Pressable>
        <Text style={styles.headerTitle}>Two-factor authentication</Text>
        <View style={{ width: 22 }} />
      </View>

      <View style={styles.content}>
        {user.mfaEnrolled ? (
          <>
            <Card style={styles.row}>
              <View style={[styles.rowIcon, { backgroundColor: colors.accentSoft }]}>
                <ShieldCheck size={18} color={colors.success} />
              </View>
              <View style={styles.rowText}>
                <Text style={styles.rowTitle}>Two-factor authentication is on</Text>
                <Text style={styles.rowDescription}>You'll be asked for a second factor when you sign in.</Text>
              </View>
            </Card>

            <Card style={styles.row}>
              <View style={styles.rowIcon}>
                <KeyRound size={18} color={colors.muted} />
              </View>
              <View style={styles.rowText}>
                <Text style={styles.rowTitle}>Backup codes</Text>
                <Text style={styles.rowDescription}>Regenerating replaces every unused code immediately.</Text>
              </View>
              <Pressable onPress={() => setStepUpAction('regenerate')} style={styles.linkBtn}>
                <Text style={styles.linkBtnText}>Regenerate</Text>
              </Pressable>
            </Card>

            <Card style={styles.row}>
              <View style={styles.rowIcon}>
                <ShieldOff size={18} color={colors.danger} />
              </View>
              <View style={styles.rowText}>
                <Text style={styles.rowTitle}>Turn off two-factor authentication</Text>
                <Text style={styles.rowDescription}>Removes your authenticator app and backup codes.</Text>
              </View>
              <Pressable onPress={() => setStepUpAction('disable')} style={[styles.linkBtn, styles.dangerBtn]}>
                <Text style={[styles.linkBtnText, styles.dangerBtnText]}>Turn off</Text>
              </Pressable>
            </Card>
          </>
        ) : enrolling ? (
          <Card>
            <TotpEnrollPanel
              onEnrolled={(result) => {
                setEnrolling(false);
                setNewBackupCodes(result.backupCodes);
                void refreshUser();
              }}
            />
          </Card>
        ) : (
          <Card style={styles.row}>
            <View style={styles.rowIcon}>
              <ShieldCheck size={18} color={colors.muted} />
            </View>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>Authenticator app</Text>
              <Text style={styles.rowDescription}>Google Authenticator, 1Password, Authy, or any TOTP app.</Text>
            </View>
            <Pressable onPress={() => setEnrolling(true)} style={styles.linkBtn}>
              <Text style={styles.linkBtnText}>Set up</Text>
            </Pressable>
          </Card>
        )}
      </View>

      <Modal visible={newBackupCodes !== null} animationType="slide" onRequestClose={() => {}}>
        <View style={[styles.modalFlex, { paddingTop: insets.top + spacing.lg }]}>
          <Text style={styles.modalTitle}>Save your backup codes</Text>
          {newBackupCodes ? <BackupCodesView codes={newBackupCodes} onDone={() => setNewBackupCodes(null)} /> : null}
        </View>
      </Modal>

      <StepUpModal
        action={stepUpAction}
        onClose={() => setStepUpAction(null)}
        onDisabled={() => void refreshUser()}
        onRegenerated={(codes) => setNewBackupCodes(codes)}
      />
    </View>
  );
}

function StepUpModal({
  action,
  onClose,
  onDisabled,
  onRegenerated,
}: {
  action: StepUpAction;
  onClose: () => void;
  onDisabled: () => void;
  onRegenerated: (codes: string[]) => void;
}) {
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { api } = useRuntime();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setPassword('');
    setCode('');
    setUseBackupCode(false);
    setError(null);
  };
  const close = () => {
    reset();
    onClose();
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    const body = { password, ...(useBackupCode ? { backupCode: code } : { totpCode: code }) };
    try {
      if (action === 'disable') {
        await api.mfaDisable(body);
        onDisabled();
      } else if (action === 'regenerate') {
        const result = await api.mfaRegenerateBackupCodes(body);
        onRegenerated(result.backupCodes);
      }
      close();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 429
          ? 'Too many attempts.'
          : 'Verification failed. Check your password and code, then try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={action !== null} animationType="fade" transparent onRequestClose={close}>
      <View style={styles.stepUpBackdrop}>
        <View style={[styles.stepUpCard, { marginBottom: insets.bottom + spacing.xl }]}>
          <Text style={styles.modalTitle}>
            {action === 'disable' ? "Confirm it's you" : "Confirm it's you to regenerate codes"}
          </Text>
          <TextField
            label="Password"
            value={password}
            onChangeText={setPassword}
            placeholder="Your password"
            secureTextEntry
            autoFocus
          />
          <TextField
            label={useBackupCode ? 'Backup code' : 'Authentication code'}
            value={code}
            onChangeText={setCode}
            placeholder={useBackupCode ? 'Backup code' : 'Authentication code'}
            keyboardType={useBackupCode ? 'default' : 'number-pad'}
          />
          <Pressable onPress={() => setUseBackupCode((v) => !v)}>
            <Text style={styles.switchModeText}>
              {useBackupCode ? 'Use an authentication code instead' : 'Use a backup code instead'}
            </Text>
          </Pressable>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={styles.stepUpActions}>
            <Button title="Cancel" variant="ghost" onPress={close} style={styles.cancelButton} />
            <Button
              title={action === 'disable' ? 'Turn off 2FA' : 'Regenerate codes'}
              onPress={submit}
              loading={busy}
              disabled={!password || code.length < 4}
              style={styles.confirmButton}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    flex: { flex: 1, backgroundColor: colors.bg },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    headerTitle: { fontSize: 16, fontWeight: '700', color: colors.fg, flex: 1, textAlign: 'center' },
    content: { padding: spacing.lg, gap: spacing.md },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    rowIcon: {
      width: 40,
      height: 40,
      borderRadius: 12,
      backgroundColor: colors.surface2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rowText: { flex: 1, gap: 2 },
    rowTitle: { fontSize: 14, fontWeight: '600', color: colors.fg },
    rowDescription: { fontSize: 12, color: colors.muted },
    linkBtn: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      borderRadius: radius.pill,
      backgroundColor: colors.surface2,
    },
    linkBtnText: { fontSize: 13, fontWeight: '600', color: colors.fg },
    dangerBtn: { backgroundColor: colors.danger },
    dangerBtnText: { color: colors.accentFg },
    modalFlex: { flex: 1, backgroundColor: colors.bg, padding: spacing.lg },
    modalTitle: { fontSize: 17, fontWeight: '700', color: colors.fg, marginBottom: spacing.md },
    stepUpBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
    stepUpCard: {
      backgroundColor: colors.surface,
      borderTopLeftRadius: radius.card,
      borderTopRightRadius: radius.card,
      padding: spacing.lg,
      gap: spacing.md,
    },
    switchModeText: { fontSize: 13, fontWeight: '600', color: colors.accent },
    error: { fontSize: 13, color: colors.danger },
    stepUpActions: { flexDirection: 'row', gap: spacing.sm, justifyContent: 'flex-end' },
    cancelButton: { paddingHorizontal: spacing.md },
    confirmButton: { paddingHorizontal: spacing.lg },
  });
}
