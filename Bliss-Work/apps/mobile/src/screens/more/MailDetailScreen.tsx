import { useEffect, useMemo } from 'react';
import { ArrowLeft } from 'lucide-react-native';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useMailDetail, useMarkMailRead } from '../../hooks/useMailInbox';
import { spacing, type ThemeColors } from '../../constants/theme';
import type { MoreStackParamList } from '../../navigation/types';
import { useThemeColors } from '../../theme/ThemeProvider';

type Props = NativeStackScreenProps<MoreStackParamList, 'MailDetail'>;

export function MailDetailScreen({ route, navigation }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { data: mail, isLoading } = useMailDetail(route.params.mailId);
  const markRead = useMarkMailRead();

  useEffect(() => {
    if (mail && !mail.readAt) markRead.mutate(mail.mailId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mail?.mailId, mail?.readAt]);

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={8}>
          <ArrowLeft size={22} color={colors.fg} />
        </Pressable>
        <Text style={styles.headerTitle}>Mail</Text>
        <View style={{ width: 22 }} />
      </View>

      {isLoading || !mail ? (
        <ActivityIndicator color={colors.accent} style={styles.spinner} />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.subject}>{mail.subject || '(no subject)'}</Text>
          <Text style={styles.meta}>
            From {mail.fromName || mail.fromAddress} · {new Date(mail.sentAt).toLocaleString()}
          </Text>
          <Text style={styles.body}>{mail.bodyText}</Text>
        </ScrollView>
      )}
    </View>
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
    headerTitle: { fontSize: 16, fontWeight: '700', color: colors.fg },
    spinner: { marginTop: spacing['2xl'] },
    content: { padding: spacing.lg, gap: spacing.sm },
    subject: { fontSize: 18, fontWeight: '700', color: colors.fg },
    meta: { fontSize: 12, color: colors.muted, marginBottom: spacing.sm },
    body: { fontSize: 14, color: colors.fg, lineHeight: 21 },
  });
}
