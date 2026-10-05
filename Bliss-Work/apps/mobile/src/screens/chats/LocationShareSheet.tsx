import { useMemo, useState } from 'react';
import { Alert, Image, Linking, StyleSheet, Text, View } from 'react-native';
import { MapPin } from 'lucide-react-native';
import { encodeLocation } from '@taskboard/app/chatEnvelope';
import { errorText } from '@taskboard/app/lib/errorText';
import { useLocationShare } from '../../hooks/useLocationShare';
import { Button } from '../../components/Button';
import { LoadingState } from '../../components/QueryState';
import { Modal } from '../../components/Modal';
import { radius, spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Sends the encoded location message through the screen's normal send path. */
  sendBody: (body: string) => Promise<unknown>;
}

/**
 * Chat -> "+" -> Location: request permission, get the fix, PREVIEW it (place
 * name + map thumbnail when the backend has a map provider), then Send posts the
 * standard location message (same envelope web renders as a location card).
 * Raw coordinates are not shown; they travel inside the message only.
 */
export function LocationShareSheet({ visible, onClose, sendBody }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { phase, retry, useApproximate } = useLocationShare(visible);
  const [sending, setSending] = useState(false);

  const send = async () => {
    if (phase.kind !== 'ready') return;
    setSending(true);
    try {
      await sendBody(encodeLocation({ lat: phase.lat, lng: phase.lng, accuracy: phase.accuracy, label: phase.label }));
      onClose();
    } catch (e) {
      Alert.alert("Couldn't send your location", errorText(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal visible={visible} onClose={onClose} title="Share location" variant="center" maxHeight="80%">
      {phase.kind === 'idle' || phase.kind === 'locating' ? (
        <LoadingState label="Getting your location..." />
      ) : null}

      {phase.kind === 'denied' ? (
        <View style={styles.block}>
          <MapPin size={28} color={colors.muted} />
          <Text style={styles.title}>Location permission needed</Text>
          <Text style={styles.muted}>
            {phase.canAskAgain
              ? 'Allow BlissWork to use your location to share where you are.'
              : 'Location access is turned off for BlissWork. Enable it in Settings to share your location.'}
          </Text>
          {phase.canAskAgain ? (
            <Button title="Allow location" onPress={() => void retry()} style={styles.btn} />
          ) : (
            <Button title="Open Settings" onPress={() => void Linking.openSettings()} style={styles.btn} />
          )}
          <Button title="Use approximate location" variant="ghost" onPress={() => void useApproximate()} />
        </View>
      ) : null}

      {phase.kind === 'error' ? (
        <View style={styles.block}>
          <MapPin size={28} color={colors.danger} />
          <Text style={styles.title}>Unable to get your location</Text>
          <Text style={styles.muted}>{phase.message}</Text>
          <Button title="Try again" onPress={() => void retry()} style={styles.btn} />
          {phase.canUseApproximate ? <Button title="Use approximate location" variant="ghost" onPress={() => void useApproximate()} /> : null}
        </View>
      ) : null}

      {phase.kind === 'ready' ? (
        <View style={styles.block}>
          {phase.mapUri ? (
            <Image source={{ uri: phase.mapUri }} style={styles.map} resizeMode="cover" accessibilityLabel="Map preview" />
          ) : (
            <View style={[styles.map, styles.mapFallback]}>
              <MapPin size={32} color={colors.accent} />
            </View>
          )}
          <Text style={styles.title} numberOfLines={2}>
            {phase.label ?? 'Your current location'}
          </Text>
          <Text style={styles.muted}>
            {phase.approximate
              ? 'Approximate location (based on your network).'
              : phase.accuracy
                ? `Accurate to about ${Math.max(1, Math.round(phase.accuracy))} m.`
                : 'Current location.'}
          </Text>
          <View style={styles.actions}>
            <Button title="Cancel" variant="ghost" onPress={onClose} style={styles.half} />
            <Button title="Send" onPress={() => void send()} loading={sending} style={styles.half} />
          </View>
        </View>
      ) : null}
    </Modal>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    block: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm },
    title: { fontSize: 16, fontWeight: '700', color: colors.fg, textAlign: 'center' },
    muted: { fontSize: 13, color: colors.muted, textAlign: 'center' },
    btn: { alignSelf: 'stretch' },
    map: { width: '100%', height: 170, borderRadius: radius.card, overflow: 'hidden' },
    mapFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentSoft },
    actions: { flexDirection: 'row', gap: spacing.sm, alignSelf: 'stretch', marginTop: spacing.xs },
    half: { flex: 1 },
  });
}
