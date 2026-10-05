import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { Lock } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { useSession } from '@taskboard/app/store/session';
import { qk } from '../hooks/queryKeys';
import { spacing, type ThemeColors } from '../constants/theme';
import { useThemeColors } from '../theme/ThemeProvider';
import { activeSecureThread, screenSecurity } from './screenSecurity';
import { navigationRef } from '../navigation/navigationRef';

const BANNER_MS = 3500;
/** One attempt = one report: same 3s coalescing window as the web/desktop guard (screenGuard.ts). */
const ATTEMPT_COALESCE_MS = 3000;

/**
 * Mounted once at the app root. On the OS's screenshot callback it (1) shows a
 * small banner and (2) posts the SAME system message desktop/web post —
 * `kind: "screenshot_attempt"` through the existing send endpoints, so it is
 * rendered as a system line, not as something the user typed — into the chat
 * or channel that was on screen. Nothing is sent when no protected thread is
 * open. One attempt = one banner + one message (coalesced over
 * ATTEMPT_COALESCE_MS, the same window the web/desktop guard uses).
 */
export function ScreenSecurityHost() {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const user = useSession((s) => s.user);
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const [shown, setShown] = useState(false);
  const fade = useRef(new Animated.Value(0)).current;
  const last = useRef(0);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // MainActivity already set FLAG_SECURE directly on the window before this ever
  // mounts (zero-race-condition protection from frame one — see its own doc);
  // this call is what actually registers the Android 14+ attempt-detection
  // callback, which only the JS-bridge `setProtected` path wires up.
  useEffect(() => screenSecurity.setProtected(true), []);

  useEffect(
    () =>
      screenSecurity.onAttempt(() => {
        const now = Date.now();
        if (now - last.current < ATTEMPT_COALESCE_MS) return;
        if (!user) return;
        const thread = activeSecureThread();
        last.current = now;
        if (__DEV__) console.debug('[BlissWork Security] Screenshot attempt detected');

        setShown(true);
        Animated.timing(fade, { toValue: 1, duration: 150, useNativeDriver: true }).start();
        if (hideTimer.current) clearTimeout(hideTimer.current);
        hideTimer.current = setTimeout(() => {
          Animated.timing(fade, { toValue: 0, duration: 250, useNativeDriver: true }).start(() => setShown(false));
        }, BANNER_MS);

        const routeName = navigationRef.isReady() ? navigationRef.getCurrentRoute()?.name : 'mobile';
        let surface = 'mobile';
        if (routeName?.includes('Chat')) surface = 'chats';
        else if (routeName?.includes('Channel')) surface = 'channels';
        else if (routeName?.includes('Mail')) surface = 'mail';
        else if (routeName?.includes('Task')) surface = 'tasks';
        else if (routeName?.includes('Meeting')) surface = 'meetings';
        else if (routeName?.includes('Setting')) surface = 'settings';
        else if (routeName?.includes('Profile')) surface = 'profile';
        else if (routeName?.includes('Member')) surface = 'members';
        else if (routeName) surface = routeName.toLowerCase();

        api
          .sendBeacon({
            sessionId: 'mobile-session',
            source: 'mobile',
            activeMs: 0,
            idleMs: 0,
            ended: false,
            events: [
              {
                action: 'screenshot.attempted',
                category: 'security',
                occurredAt: new Date().toISOString(),
                surface: surface,
              },
            ],
          })
          .catch(() => undefined);

        if (thread) {
          // Same wording and the same real name desktop uses (displayName wins over the email local-part).
          const body = `${user.displayName || user.username} tried to take a screenshot`;
          if (thread.kind === 'chat') {
            api
              .sendMessage(thread.peerId, body, undefined, 'screenshot_attempt')
              .then(() => {
                void qc.invalidateQueries({ queryKey: qk.messages(thread.conversationId) });
                void qc.invalidateQueries({ queryKey: qk.conversations });
                if (__DEV__) console.debug('[BlissWork Security] Screenshot event sent');
              })
              .catch(() => undefined);
          } else {
            api
              .sendChannelMessage(thread.channelId, body, undefined, 'screenshot_attempt')
              .then(() => {
                void qc.invalidateQueries({ queryKey: qk.channelMessages(thread.channelId) });
                void qc.invalidateQueries({ queryKey: qk.channels });
                if (__DEV__) console.debug('[BlissWork Security] Screenshot event sent');
              })
              .catch(() => undefined);
          }
        }
      }),
    [api, qc, user, fade],
  );

  useEffect(() => () => void (hideTimer.current && clearTimeout(hideTimer.current)), []);

  if (!shown) return null;
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.wrap, { top: insets.top + spacing.sm, opacity: fade }]}
      accessibilityLiveRegion="assertive"
    >
      <View style={styles.card}>
        <Lock size={18} color={colors.danger ?? colors.accent} />
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Screenshot Blocked</Text>
          <Text style={styles.body}>Screenshots are not allowed in this conversation.</Text>
        </View>
      </View>
    </Animated.View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    wrap: { position: 'absolute', left: spacing.md, right: spacing.md, alignItems: 'center', zIndex: 1000, elevation: 20 },
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      width: '100%',
      maxWidth: 420,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    title: { color: colors.fg, fontSize: 14, fontWeight: '700' },
    body: { color: colors.muted, fontSize: 12, marginTop: 1 },
  });
}
