import { useEffect, useMemo } from 'react';
import { ArrowLeft, Forward, Reply, ReplyAll, Star, Trash2 } from 'lucide-react-native';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSession } from '@taskboard/app/store/session';
import { useAttachmentLinks } from '@taskboard/app/lib/useAttachmentLinks';
import { prettySize } from '@taskboard/app/chatEnvelope';
import { errorText } from '@taskboard/app/lib/errorText';
import {
  forwardBody,
  forwardSubject,
  formatMailTime,
  hasWiderReply,
  quoteBody,
  replyAllRecipients,
  replyRecipients,
  replySubject,
  summarizeRecipients,
  type MailPrefill,
} from '@taskboard/app/lib/mailActions';
import { useMailDetail, useMarkMailRead } from '../../hooks/useMailInbox';
import { useDeleteMail } from '../../hooks/useMailBoxes';
import { toggleMailFavorite, useMailPrefs } from '../../lib/mailPrefs';
import { ErrorState, LoadingState } from '../../components/QueryState';
import { FileGlyph, fileTypeLabel } from '../../components/FileGlyph';
import { openAttachment } from '../../attachments/openAttachment';
import { radius, spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';
import type { ChatsStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<ChatsStackParamList, 'MailDetail'>;

/** Reads one mail and offers Reply / Reply all / Forward (same prefill rules as web's mailActions.ts), Delete and Favourite. */
export function MailDetailScreen({ route, navigation }: Props) {
  const { mailId } = route.params;
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const me = useSession((s) => s.user);
  const { data: mail, isLoading, isError, error, refetch, isRefetching } = useMailDetail(mailId);
  const markRead = useMarkMailRead();
  const del = useDeleteMail();
  const prefs = useMailPrefs();
  // Signed, short-lived links minted per attachment id — the same private mechanism chat uses.
  const attachmentIds = useMemo(() => mail?.attachments.map((a) => a.id) ?? [], [mail?.attachments]);
  const links = useAttachmentLinks(attachmentIds);
  const starred = prefs.isFavorite(mailId);

  useEffect(() => {
    if (mail && !mail.readAt && mail.status !== 'DRAFT') markRead.mutate(mail.mailId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mail?.mailId, mail?.readAt]);

  const compose = (prefill: MailPrefill) => navigation.navigate('MailCompose', { prefill });

  const myAddress = me?.email ?? '';
  const senderLabel = mail ? mail.fromName || mail.fromAddress : '';

  const onReply = () => {
    if (!mail) return;
    compose({
      to: replyRecipients(mail, myAddress),
      subject: replySubject(mail.subject),
      quoted: quoteBody(senderLabel, mail.sentAt, mail.bodyText),
      kind: 'reply',
    });
  };
  const onReplyAll = () => {
    if (!mail) return;
    const { to, cc } = replyAllRecipients(mail, myAddress);
    compose({ to, cc, subject: replySubject(mail.subject), quoted: quoteBody(senderLabel, mail.sentAt, mail.bodyText), kind: 'reply' });
  };
  const onForward = () => {
    if (!mail) return;
    compose({ to: [], subject: forwardSubject(mail.subject), quoted: forwardBody(mail, senderLabel), kind: 'forward' });
  };

  const onDelete = () =>
    del.mutate(mailId, {
      onSuccess: () => navigation.goBack(),
      onError: (e) => Alert.alert('Could not delete this mail', errorText(e)),
    });

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={8} accessibilityLabel="Back">
          <ArrowLeft size={22} color={colors.fg} />
        </Pressable>
        <Text style={styles.headerTitle}>Mail</Text>
        {mail ? (
          <View style={styles.headerActions}>
            <Pressable hitSlop={8} onPress={() => toggleMailFavorite(mailId)} accessibilityLabel={starred ? 'Remove from favourites' : 'Add to favourites'}>
              <Star size={20} color={starred ? colors.warning : colors.muted} fill={starred ? colors.warning : 'transparent'} />
            </Pressable>
            <Pressable hitSlop={8} onPress={onDelete} disabled={del.isPending} accessibilityLabel="Delete mail">
              <Trash2 size={20} color={colors.muted} />
            </Pressable>
          </View>
        ) : (
          <View style={{ width: 22 }} />
        )}
      </View>

      {isLoading ? (
        <LoadingState label="Loading mail..." />
      ) : isError || !mail ? (
        <ErrorState title="Unable to open this mail" error={error} onRetry={() => void refetch()} />
      ) : (
        <>
          <ScrollView
            contentContainerStyle={styles.content}
            refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.accent} />}
          >
            <Text style={styles.subject}>{mail.subject || '(no subject)'}</Text>
            <Text style={styles.meta}>
              From {senderLabel}
              {mail.fromName && mail.fromAddress ? ` <${mail.fromAddress}>` : ''}
            </Text>
            <Text style={styles.meta}>To {summarizeRecipients(mail.recipients.filter((r) => r.kind === 'TO')) || '—'}</Text>
            {mail.recipients.some((r) => r.kind === 'CC') ? (
              <Text style={styles.meta}>Cc {summarizeRecipients(mail.recipients.filter((r) => r.kind === 'CC'))}</Text>
            ) : null}
            <Text style={[styles.meta, styles.metaLast]}>{formatMailTime(mail.sentAt)}</Text>

            {mail.attachments.length > 0 ? (
              <View style={styles.attachments}>
                {mail.attachments.map((a) => (
                  <Pressable
                    key={a.id}
                    style={styles.attachment}
                    // Never a bare Linking.openURL — images open in the in-app viewer, the rest in the details sheet.
                    onPress={() => openAttachment({ name: a.filename, size: a.sizeBytes, mime: a.mime }, links.urlFor(a.id))}
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${a.filename}`}
                  >
                    <FileGlyph mime={a.mime} name={a.filename} size={36} />
                    <View style={styles.attachmentText}>
                      <Text style={styles.attachmentName} numberOfLines={1}>
                        {a.filename}
                      </Text>
                      <Text style={styles.attachmentSize}>{`${fileTypeLabel(a.mime, a.filename)} · ${prettySize(a.sizeBytes)}`}</Text>
                    </View>
                  </Pressable>
                ))}
              </View>
            ) : null}

            <Text style={styles.body} selectable>
              {mail.bodyText}
            </Text>
          </ScrollView>

          <View style={[styles.actions, { paddingBottom: insets.bottom + spacing.sm }]}>
            <ActionButton icon={Reply} label="Reply" onPress={onReply} colors={colors} />
            {hasWiderReply(mail, myAddress) ? <ActionButton icon={ReplyAll} label="Reply all" onPress={onReplyAll} colors={colors} /> : null}
            <ActionButton icon={Forward} label="Forward" onPress={onForward} colors={colors} />
          </View>
        </>
      )}
    </View>
  );
}

function ActionButton({ icon: Icon, label, onPress, colors }: { icon: typeof Reply; label: string; onPress: () => void; colors: ThemeColors }) {
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <Pressable onPress={onPress} style={styles.actionBtn} accessibilityRole="button">
      <Icon size={17} color={colors.accent} />
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    flex: { flex: 1, backgroundColor: colors.bg },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    headerTitle: { flex: 1, fontSize: 16, fontWeight: '700', color: colors.fg },
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
    content: { padding: spacing.lg, gap: 2 },
    subject: { fontSize: 20, fontWeight: '700', color: colors.fg, marginBottom: spacing.sm },
    meta: { fontSize: 13, color: colors.muted },
    metaLast: { marginBottom: spacing.md },
    attachments: { gap: spacing.xs, marginBottom: spacing.md },
    attachment: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      padding: spacing.sm,
      borderRadius: radius.card,
      backgroundColor: colors.surface2,
    },
    attachmentText: { flex: 1 },
    attachmentName: { fontSize: 14, fontWeight: '600', color: colors.fg },
    attachmentSize: { fontSize: 12, color: colors.muted },
    body: { fontSize: 15, lineHeight: 22, color: colors.fg },
    actions: {
      flexDirection: 'row',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
      backgroundColor: colors.surface,
    },
    actionBtn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs,
      paddingVertical: spacing.md,
      borderRadius: radius.pill,
      backgroundColor: colors.accentSoft,
    },
    actionText: { fontSize: 14, fontWeight: '600', color: colors.accent },
  });
}
