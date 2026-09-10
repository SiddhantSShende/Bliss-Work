import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { SvgXml } from 'react-native-svg';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { ApiError, type MfaTotpEnrollConfirmResult } from '@taskboard/shared';
import { TextField } from '../../components/TextField';
import { Button } from '../../components/Button';
import { radius, spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';

/**
 * Mirrors packages/app/src/features/TotpEnrollPanel.tsx (web): generate a
 * secret, show it as a QR code + plain text, collect the 6-digit code,
 * confirm. The QR is rendered from `qrcode`'s pure-JS `toString(..., {type:
 * 'svg'})` path (no Canvas/DOM — RN has neither) via react-native-svg's
 * SvgXml, instead of web's `toDataURL()` <img>. The secret only ever lives
 * in this component's own state, same as web — sent back exactly once, on
 * confirm.
 */
export function TotpEnrollPanel({ onEnrolled }: { onEnrolled: (result: MfaTotpEnrollConfirmResult) => void }) {
  const { api } = useRuntime();
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [secret, setSecret] = useState<string | null>(null);
  const [qrSvg, setQrSvg] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startError, setStartError] = useState(false);
  const [startAttempt, setStartAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setStartError(false);
    api
      .mfaTotpEnrollStart()
      .then(async (r) => {
        if (!alive) return;
        setSecret(r.secret);
        const svg = await QRCode.toString(r.otpauthUrl, { type: 'svg', margin: 1, width: 220 });
        if (alive) setQrSvg(svg);
      })
      .catch(() => {
        if (alive) setStartError(true);
      });
    return () => {
      alive = false;
    };
  }, [api, startAttempt]);

  const confirm = async () => {
    if (!secret) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.mfaTotpEnrollConfirm({ secret, code });
      onEnrolled(result);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 429
          ? 'Too many attempts — wait a minute before trying again.'
          : 'Incorrect code. Check the time on your device and try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  if (startError) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>Couldn't start enrollment.</Text>
        <Button title="Try again" variant="ghost" onPress={() => setStartAttempt((n) => n + 1)} />
      </View>
    );
  }

  if (!secret || !qrSvg) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.accent} />
        <Text style={styles.muted}>Preparing enrollment…</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.muted}>
        Scan this with an authenticator app (Google Authenticator, 1Password, Authy, …), or enter the setup key
        manually.
      </Text>
      <View style={styles.qrWrap}>
        <SvgXml xml={qrSvg} width={200} height={200} />
      </View>
      <View style={styles.secretBox}>
        <Text style={styles.secretLabel}>SETUP KEY</Text>
        <Text style={styles.secretValue} selectable>
          {secret}
        </Text>
      </View>
      <TextField
        label="Enter the 6-digit code"
        value={code}
        onChangeText={setCode}
        placeholder="123456"
        keyboardType="number-pad"
        maxLength={10}
        autoFocus
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button title={busy ? 'Verifying…' : 'Confirm and enable'} onPress={confirm} loading={busy} disabled={code.length < 6} />
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { gap: spacing.md },
    centered: { alignItems: 'center', justifyContent: 'center', gap: spacing.sm, paddingVertical: spacing.xl },
    muted: { fontSize: 13, color: colors.muted, textAlign: 'center' },
    qrWrap: { alignItems: 'center', padding: spacing.md, backgroundColor: '#ffffff', borderRadius: radius.card },
    secretBox: {
      backgroundColor: colors.surface2,
      borderRadius: 12,
      padding: spacing.md,
      alignItems: 'center',
      gap: 4,
    },
    secretLabel: { fontSize: 11, fontWeight: '700', color: colors.muted, letterSpacing: 0.5 },
    secretValue: { fontSize: 14, fontWeight: '600', color: colors.fg },
    error: { fontSize: 13, color: colors.danger },
  });
}
