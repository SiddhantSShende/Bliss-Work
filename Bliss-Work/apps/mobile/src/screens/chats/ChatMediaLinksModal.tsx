import { useMemo } from 'react';
import { FileText, Link2 } from 'lucide-react-native';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useCalls } from '../../calls/CallProvider';
import type { MediaItem } from '@taskboard/app/chatEnvelope';
import { openAttachment } from '../../attachments/openAttachment';
import { EmptyState } from '../../components/EmptyState';
import { Modal } from '../../components/Modal';
import { spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';

interface ChatMediaLinksModalProps {
  visible: boolean;
  onClose: () => void;
  files: MediaItem[];
  links: string[];
  /** Same resolver ChatConversationScreen already batches via
   *  `useAttachmentLinks` for the message list — reused here instead of a
   *  second fetch. */
  urlFor: (id: string | undefined) => string | undefined;
}

/** "Media, Links & Docs" — everything already loaded for this conversation,
 *  not a separate fetch: attachments come from the same envelopes
 *  ChatConversationScreen already parses for the message list, and links are
 *  scanned out of those same message bodies. Nothing here reaches further
 *  back than what's currently paged in, same "searches what's loaded"
 *  honesty as the message search bar. */
export function ChatMediaLinksModal({ visible, onClose, files, links, urlFor }: ChatMediaLinksModalProps) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { openCallLink } = useCalls();

  // Image → the in-app lightbox; PDF/text → the in-app doc preview; anything
  // else → the file-details sheet with an explicit external-open action.
  // Never a bare Linking.openURL straight to the browser — see openAttachment.
  const openFile = (item: MediaItem) => openAttachment(item, urlFor(item.id));

  return (
    <Modal visible={visible} onClose={onClose} title="Media, Links & Docs" maxHeight="75%">
      <View>
        <Text style={styles.sectionLabel}>Files ({files.length})</Text>
        {files.length === 0 ? (
          <EmptyState icon={FileText} title="No files yet" subtitle="Shared files and photos will show up here." />
        ) : (
          files.map((item) => (
            <Pressable key={item.id} onPress={() => openFile(item)} style={styles.row}>
              <View style={styles.iconWrap}>
                <FileText size={16} color={colors.accent} />
              </View>
              <Text style={styles.rowText} numberOfLines={1}>
                {item.name}
              </Text>
            </Pressable>
          ))
        )}

        <Text style={styles.sectionLabel}>Links ({links.length})</Text>
        {links.length === 0 ? (
          <EmptyState icon={Link2} title="No links yet" subtitle="Links shared in this chat will show up here." />
        ) : (
          links.map((link) => (
            <Pressable key={link} onPress={() => {
              // A BlissWork call link joins in-app; every other link opens as before.
              if (!openCallLink(link)) void Linking.openURL(link);
            }} style={styles.row}>
              <View style={styles.iconWrap}>
                <Link2 size={16} color={colors.accent} />
              </View>
              <Text style={styles.rowText} numberOfLines={1}>
                {link}
              </Text>
            </Pressable>
          ))
        )}
      </View>
    </Modal>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    scroll: { marginBottom: spacing.sm },
    sectionLabel: {
      fontSize: 12,
      fontWeight: '700',
      color: colors.muted,
      textTransform: 'uppercase',
      letterSpacing: 0.4,
      marginTop: spacing.md,
      marginBottom: spacing.xs,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm,
    },
    iconWrap: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: colors.accentSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rowText: { flex: 1, fontSize: 14, color: colors.fg },
  });
}
