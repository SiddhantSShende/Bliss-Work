import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Send, Trash2 } from 'lucide-react-native';
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isValidMailAddress } from '@taskboard/shared';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { errorText } from '@taskboard/app/lib/errorText';
import { useMailDraft } from '../../hooks/useMailDraft';
import { useMailAttachments } from '../../hooks/useMailAttachments';
import { qk } from '../../hooks/queryKeys';
import { ErrorState, LoadingState } from '../../components/QueryState';
import { MailAttachmentTray } from '../../components/MailAttachmentTray';
import { spacing, radius, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';
import type { ChatsStackParamList } from '../../navigation/types';
import { MailAddressField } from './MailAddressField';

type Props = NativeStackScreenProps<ChatsStackParamList, 'MailCompose'>;

/** Mirrors store.MaxMailSubjectRunes (enforced server-side; this is the counter). */
const MAX_SUBJECT = 200;

function sentSummary(inApp: number, external: number): string {
  if (external === 0) return inApp === 1 ? 'Sent' : `Sent to ${inApp} people`;
  if (inApp === 0) return external === 1 ? 'Sent — delivering' : `Sent — delivering to ${external}`;
  return `Sent to ${inApp} here, delivering to ${external} more`;
}

/**
 * Mail composer — New Mail / Reply / Reply all / Forward / resumed Draft.
 *
 * Same flow and endpoints as web's MailCompose.tsx: a server-side draft is
 * opened with the composer (createMailDraft), edits autosave (saveMailDraft),
 * Send calls sendMail, Discard calls discardMailDraft. Leaving without sending
 * keeps a non-empty draft in Drafts and drops an untouched one.
 *
 * Attachments follow web too: files upload against the draft as they are picked
 * (useMailAttachments) and sendMail commits whatever is on the draft, so Send
 * waits for in-flight uploads/removals and is blocked while a file has failed.
 */
export function MailComposeScreen({ route, navigation }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { api } = useRuntime();
  const qc = useQueryClient();
  const draftId = route.params?.draftId;
  const prefill = route.params?.prefill;

  const resumed = useQuery({
    queryKey: qk.mailDetail(draftId ?? ''),
    queryFn: () => api.mail(draftId!),
    enabled: !!draftId,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const [to, setTo] = useState<string[]>(prefill?.to ?? []);
  const [cc, setCc] = useState<string[]>(prefill?.cc ?? []);
  const [bcc, setBcc] = useState<string[]>([]);
  const [showCc, setShowCc] = useState((prefill?.cc?.length ?? 0) > 0);
  const [subject, setSubject] = useState(prefill?.subject ?? '');
  const [body, setBody] = useState(prefill?.quoted ?? '');
  const [loadedId, setLoadedId] = useState<string>();
  const [sendError, setSendError] = useState<string | null>(null);

  const heading = draftId ? 'Draft' : prefill?.kind === 'forward' ? 'Forward' : prefill ? 'Reply' : 'New Mail';

  useEffect(() => {
    const mail = resumed.data;
    if (!mail || mail.mailId === loadedId) return;
    setLoadedId(mail.mailId);
    setTo(mail.recipients.filter((r) => r.kind === 'TO').map((r) => r.address));
    const ccs = mail.recipients.filter((r) => r.kind === 'CC').map((r) => r.address);
    setCc(ccs);
    if (ccs.length) setShowCc(true);
    const bccs = mail.recipients.filter((r) => r.kind === 'BCC').map((r) => r.address);
    setBcc(bccs);
    if (bccs.length) setShowCc(true);
    setSubject(mail.subject);
    setBody(mail.bodyText);
  }, [resumed.data, loadedId]);

  const draft = useMailDraft(draftId);
  const { mailId, save: saveDraft } = draft;
  const attachments = useMailAttachments(mailId, resumed.data?.attachments);
  const hasAttachments = attachments.items.length > 0;

  useEffect(() => {
    if (!mailId) return;
    if (draftId && !resumed.data) return; // don't overwrite a draft with the empty form
    saveDraft({ to, cc, bcc, subject, bodyText: body, hasAttachments });
  }, [mailId, draftId, resumed.data, saveDraft, to, cc, bcc, subject, body, hasAttachments]);

  const all = [...to, ...cc, ...bcc];
  const invalid = all.find((a) => !isValidMailAddress(a));
  const subjectTooLong = subject.length > MAX_SUBJECT;
  const canSend = !!mailId && all.length > 0 && !invalid && !subjectTooLong && !attachments.isBusy && !attachments.hasFailed;

  const send = useMutation({
    mutationFn: async () => {
      if (!mailId) throw new Error('Draft is not ready yet');
      if (attachments.isBusy || attachments.hasFailed) throw new Error('Wait for attachments to finish uploading, or remove the ones that failed.');
      return api.sendMail(mailId, { to, cc, bcc, subject: subject.trim(), bodyText: body });
    },
    onMutate: () => setSendError(null),
    onSuccess: (res) => {
      draft.markSent();
      void qc.invalidateQueries({ queryKey: qk.mailInbox });
      Alert.alert(sentSummary(res.deliveredInApp, res.queuedExternal));
      navigation.goBack();
    },
    // The server names the field that is wrong (a rejected address, a long subject).
    onError: (e) => setSendError(errorText(e)),
  });

  const confirmDiscard = () =>
    Alert.alert('Discard this draft?', undefined, [
      { text: 'Keep editing', style: 'cancel' },
      {
        text: 'Discard',
        style: 'destructive',
        onPress: () => {
          void draft.discard().catch((e) => Alert.alert('Could not discard the draft', errorText(e)));
          navigation.goBack();
        },
      },
    ]);

  if (draftId && resumed.isLoading) {
    return (
      <View style={[styles.flex, { paddingTop: insets.top }]}>
        <LoadingState label="Opening draft..." />
      </View>
    );
  }
  if (draftId && resumed.isError) {
    return (
      <View style={[styles.flex, { paddingTop: insets.top }]}>
        <ErrorState title="Unable to open this draft" error={resumed.error} onRetry={() => void resumed.refetch()} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={[styles.flex, { paddingTop: insets.top }]} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={8} accessibilityLabel="Close composer">
          <ArrowLeft size={22} color={colors.fg} />
        </Pressable>
        <Text style={styles.headerTitle}>{heading}</Text>
        <View style={styles.headerActions}>
          <Pressable onPress={confirmDiscard} hitSlop={8} accessibilityLabel="Discard draft" disabled={!mailId}>
            <Trash2 size={20} color={mailId ? colors.muted : colors.border} />
          </Pressable>
          <Pressable
            onPress={() => send.mutate()}
            disabled={!canSend || send.isPending}
            style={[styles.sendBtn, (!canSend || send.isPending) && styles.sendBtnDisabled]}
            accessibilityLabel="Send"
          >
            <Send size={16} color={colors.accentFg} />
            <Text style={styles.sendText}>{send.isPending ? 'Sending...' : attachments.isBusy ? 'Uploading...' : 'Send'}</Text>
          </Pressable>
        </View>
      </View>

      {draft.isError ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>Couldn't open a draft, so Send is unavailable.</Text>
          <Pressable onPress={draft.retry}>
            <Text style={styles.bannerAction}>Retry</Text>
          </Pressable>
        </View>
      ) : null}

      <ScrollView contentContainerStyle={[styles.form, { paddingBottom: insets.bottom + spacing.xl }]} keyboardShouldPersistTaps="handled">
        <MailAddressField label="To" value={to} onChange={setTo} autoFocus={!prefill && !draftId} />
        {showCc ? (
          <>
            <MailAddressField label="Cc" value={cc} onChange={setCc} />
            <MailAddressField label="Bcc" value={bcc} onChange={setBcc} />
          </>
        ) : (
          <Pressable onPress={() => setShowCc(true)} style={styles.ccToggle}>
            <Text style={styles.ccToggleText}>Add Cc / Bcc</Text>
          </Pressable>
        )}

        <TextInput
          value={subject}
          onChangeText={setSubject}
          placeholder="Subject"
          placeholderTextColor={colors.muted}
          style={styles.subject}
          accessibilityLabel="Subject"
        />
        {subjectTooLong ? <Text style={styles.error}>Subject must be at most {MAX_SUBJECT} characters.</Text> : null}

        <MailAttachmentTray
          items={attachments.items}
          onAttach={() => void attachments.pick()}
          onRemove={(key) => !send.isPending && attachments.remove(key)}
          onRetry={attachments.retry}
          disabled={!mailId || send.isPending}
        />

        <TextInput
          value={body}
          onChangeText={setBody}
          placeholder="Write your message..."
          placeholderTextColor={colors.muted}
          style={styles.body}
          multiline
          textAlignVertical="top"
          accessibilityLabel="Message body"
        />

        {invalid ? <Text style={styles.error}>"{invalid}" is not a valid email address.</Text> : null}
        {attachments.hasFailed ? <Text style={styles.error}>Retry or remove the attachments that failed to upload before sending.</Text> : null}
        {sendError ? <Text style={styles.error}>{sendError}</Text> : null}
      </ScrollView>
    </KeyboardAvoidingView>
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
    headerTitle: { flex: 1, fontSize: 17, fontWeight: '700', color: colors.fg },
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
    sendBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.pill,
      backgroundColor: colors.accent,
    },
    sendBtnDisabled: { opacity: 0.45 },
    sendText: { color: colors.accentFg, fontWeight: '600', fontSize: 14 },
    banner: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginHorizontal: spacing.lg,
      padding: spacing.md,
      borderRadius: radius.card,
      backgroundColor: colors.accentSoft,
    },
    bannerText: { flex: 1, fontSize: 13, color: colors.fg },
    bannerAction: { fontSize: 13, fontWeight: '700', color: colors.accent },
    form: { paddingHorizontal: spacing.lg },
    ccToggle: { paddingVertical: spacing.sm },
    ccToggleText: { fontSize: 13, fontWeight: '600', color: colors.accent },
    subject: {
      fontSize: 16,
      fontWeight: '600',
      color: colors.fg,
      paddingVertical: spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    body: { minHeight: 240, fontSize: 15, lineHeight: 22, color: colors.fg, paddingTop: spacing.md },
    error: { fontSize: 13, color: colors.danger, marginTop: spacing.sm },
  });
}
