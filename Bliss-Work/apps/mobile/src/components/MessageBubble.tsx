import { useMemo } from 'react';
import { ActivityIndicator, Image, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Check, CheckCheck, Clock, ExternalLink, FileText, MapPin, Play } from 'lucide-react-native';
import { LinearGradient } from 'expo-linear-gradient';
import type { MessageDTO } from '@taskboard/shared';
import { parseChatEnvelope, prettySize, readablePrefix, type MediaItem } from '@taskboard/app/chatEnvelope';
import { formatCoords } from '@taskboard/app/lib/mapsLink';
import { mapsLink } from '../lib/mapsLink';
import { mediaCaption } from '../lib/attachmentCaption';
import { openAttachment, openImageGroup } from '../attachments/openAttachment';
import { LinkedText } from './LinkedText';
import { radius, spacing, type ThemeColors } from '../constants/theme';
import { useThemeColors } from '../theme/ThemeProvider';

/** The subset of MessageDTO/ChannelMessageDTO this bubble actually renders —
 *  shared by DMs and channels, which is why this isn't just `MessageDTO`:
 *  ChannelMessageDTO has no `status` field (no per-viewer read receipt on
 *  channel messages) and no `conversationId`, so it doesn't structurally
 *  satisfy MessageDTO. */
export interface RenderableMessage {
  body: string;
  /** Set for system entries (e.g. "screenshot_attempt"); absent = an ordinary message. */
  kind?: string;
  status?: MessageDTO['status'];
  deletedForAll?: boolean;
}

interface MessageBubbleProps {
  message: RenderableMessage;
  /** Whether the signed-in user sent this one — the only thing that decides
   *  alignment/color; there is no other "mine" signal on the DTO itself. */
  mine: boolean;
  time: string;
  /** Resolves an attachment id to a signed download URL, batched for the
   *  whole message list by `useAttachmentLinks` in the parent screen — see
   *  that hook's own doc for why this must be minted once per screen rather
   *  than once per bubble. Omitted on surfaces that never pass media
   *  messages through (there are none today, but callers with only plain
   *  text can skip the plumbing). */
  urlFor?: (id: string | undefined) => string | undefined;
  /** Whether `urlFor`'s batch has completed at least once — before that, a
   *  missing URL means "still loading"; after, it means "not available to
   *  you" (e.g. a forwarded attachment from a conversation you're not in). */
  isResolved?: boolean;
  /** Sender's name, shown above others' messages in a channel (DMs omit it). */
  senderName?: string;
}

/** One chat/channel message bubble: purple gradient for outgoing, light
 *  surface for incoming, per the reference. Read-receipt ticks only ever
 *  render on the sender's own bubbles (`MessageDTO.status` is documented as
 *  "set only on the sender's own bubbles"). A body carrying a structured
 *  envelope (see chatEnvelope.ts) renders as a location card or file/image
 *  attachments instead of raw text — everything else (plain text, and the
 *  legacy v1 peer-to-peer file offer mobile never implemented a transfer UI
 *  for) falls back to its readable prefix. */
export function MessageBubble({ message, mine, time, urlFor, isResolved, senderName }: MessageBubbleProps) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const envelope = useMemo(() => parseChatEnvelope(message.body), [message.body]);

  if (message.deletedForAll) {
    return (
      <View style={[styles.row, mine && styles.rowMine]}>
        <View style={[styles.bubble, styles.tombstone]}>
          <Text style={styles.tombstoneText}>This message was deleted</Text>
        </View>
      </View>
    );
  }

  let content;
  if (envelope?.kind === 'location') {
    content = (
      <LocationContent
        lat={envelope.lat}
        lng={envelope.lng}
        label={envelope.label}
        accuracy={envelope.accuracy}
        mine={mine}
        colors={colors}
      />
    );
  } else if (envelope?.kind === 'media') {
    content = (
      <MediaContent items={envelope.items} mine={mine} urlFor={urlFor} isResolved={!!isResolved} colors={colors} />
    );
  } else {
    const text = envelope?.kind === 'fileOffer' ? readablePrefix(message.body) : message.body;
    content = (
      <LinkedText
        text={text}
        style={mine ? styles.textMine : styles.textTheirs}
        linkStyle={mine ? styles.linkMine : styles.linkTheirs}
      />
    );
  }

  const body = (
    <>
      {!mine && senderName ? (
        <Text style={styles.sender} numberOfLines={1}>
          {senderName}
        </Text>
      ) : null}
      {content}
      <View style={styles.meta}>
        <Text style={mine ? styles.timeMine : styles.timeTheirs}>{time}</Text>
        {mine ? <ReceiptIcon status={message.status} /> : null}
      </View>
    </>
  );

  return (
    <View style={[styles.row, mine && styles.rowMine]}>
      {mine ? (
        <LinearGradient
          colors={[colors.brandFrom, colors.brandTo]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[styles.bubble, styles.bubbleMine]}
        >
          {body}
        </LinearGradient>
      ) : (
        <View style={[styles.bubble, styles.bubbleTheirs]}>{body}</View>
      )}
    </View>
  );
}

/** A shared location: coordinates card with a pin, tappable straight through
 *  to the device's Maps app — mirrors packages/app/src/features/
 *  LocationBubble.tsx's "coordinates card is the product" design, minus the
 *  static map thumbnail (an enhancement layered on top there; skipped here
 *  rather than plumbing a Blob-to-`Image`-uri bridge for a decoration). */
function LocationContent({
  lat,
  lng,
  label,
  accuracy,
  mine,
  colors,
}: {
  lat: number;
  lng: number;
  label?: string;
  accuracy?: number;
  mine: boolean;
  colors: ThemeColors;
}) {
  const title = label || 'Shared location';
  return (
    <Pressable onPress={() => void Linking.openURL(mapsLink(lat, lng, label))} style={locationStyles.row}>
      <View style={[locationStyles.iconWrap, { backgroundColor: mine ? 'rgba(255,255,255,0.18)' : colors.accentSoft }]}>
        <MapPin size={18} color={mine ? colors.accentFg : colors.accent} />
      </View>
      <View style={locationStyles.textWrap}>
        <Text numberOfLines={1} style={[locationStyles.title, { color: mine ? colors.accentFg : colors.fg }]}>
          {title}
        </Text>
        <Text style={[locationStyles.subtitle, { color: mine ? 'rgba(255,255,255,0.75)' : colors.muted }]}>
          {formatCoords(lat, lng)}
          {accuracy !== undefined && accuracy > 0 ? ` · ±${Math.round(accuracy)} m` : ''}
        </Text>
      </View>
      <ExternalLink size={14} color={mine ? colors.accentFg : colors.accent} />
    </Pressable>
  );
}

/** Attachments of one media message: an image/video grid, then any
 *  non-visual files as a stacked list — mirrors packages/app/src/features/
 *  MediaBubble.tsx's split, minus the in-app gallery Lightbox (tapping opens
 *  the signed URL via the OS instead, which is what mobile has to work with
 *  without building a full-screen viewer for this change). */
function MediaContent({
  items,
  mine,
  urlFor,
  isResolved,
  colors,
}: {
  items: MediaItem[];
  mine: boolean;
  urlFor?: (id: string | undefined) => string | undefined;
  isResolved: boolean;
  colors: ThemeColors;
}) {
  const visuals = items.filter((i) => i.mime.startsWith('image/') || i.mime.startsWith('video/'));
  const others = items.filter((i) => !visuals.includes(i));
  // A screen that never wired up `useAttachmentLinks` (channels don't, today
  // — see ChatConversationScreen's own comment on why) has no way to ever
  // resolve a url, so `isResolved` staying false forever must not spin
  // forever; treat "no resolver at all" as already-settled.
  const linksSupported = typeof urlFor === 'function';

  // Images open the in-app lightbox (as a swipeable set of every image in
  // THIS message, not just the one tapped); a video (no in-app player exists)
  // and every other file type open through the shared classify-and-open
  // dispatcher — never a bare Linking.openURL straight to the OS/browser.
  const openVisual = (item: MediaItem) => {
    if (item.mime.startsWith('image/')) {
      openImageGroup(visuals, (i) => urlFor?.(i.id), item);
    } else {
      openAttachment(item, urlFor?.(item.id));
    }
  };
  const openFile = (item: MediaItem) => openAttachment(item, urlFor?.(item.id));

  return (
    <View style={mediaStyles.container}>
      <Text style={[mediaStyles.caption, { color: mine ? 'rgba(255,255,255,0.85)' : colors.muted }]}>
        {mediaCaption(items, mine)}
      </Text>
      {visuals.length > 0 ? (
        <View style={mediaStyles.grid}>
          {visuals.map((item) => {
            // A video with no poster must not be handed to <Image> (it cannot
            // decode mp4 and would render blank); mobile uploads have no poster.
            const isVideo = item.mime.startsWith('video/');
            const url = isVideo && !item.thumbId ? undefined : urlFor?.(item.thumbId) ?? urlFor?.(item.id);
            return (
              <Pressable key={item.id} onPress={() => openVisual(item)} style={mediaStyles.visualTile}>
                {url ? (
                  <Image source={{ uri: url }} style={mediaStyles.visualImage} resizeMode="cover" />
                ) : (
                  <View style={[mediaStyles.visualImage, mediaStyles.placeholder]}>
                    {isVideo ? (
                      <Play size={22} color={colors.muted} />
                    ) : !linksSupported || isResolved ? (
                      <FileText size={16} color={colors.muted} />
                    ) : (
                      <ActivityIndicator size="small" color={colors.muted} />
                    )}
                  </View>
                )}
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {others.map((item) => {
        const url = urlFor?.(item.id);
        return (
          <Pressable key={item.id} onPress={() => openFile(item)} style={mediaStyles.fileRow}>
            <View
              style={[mediaStyles.fileIconWrap, { backgroundColor: mine ? 'rgba(255,255,255,0.18)' : colors.accentSoft }]}
            >
              <FileText size={16} color={mine ? colors.accentFg : colors.accent} />
            </View>
            <View style={mediaStyles.fileTextWrap}>
              <Text numberOfLines={1} style={[mediaStyles.fileName, { color: mine ? colors.accentFg : colors.fg }]}>
                {item.name}
              </Text>
              <Text style={[mediaStyles.fileMeta, { color: mine ? 'rgba(255,255,255,0.75)' : colors.muted }]}>
                {isResolved && !url ? 'Not available' : prettySize(item.size)}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

function ReceiptIcon({ status }: { status: MessageDTO['status'] }) {
  if (status === 'SEEN') return <CheckCheck size={14} color="#dbeafe" />;
  if (status === 'DELIVERED') return <CheckCheck size={14} color="rgba(255,255,255,0.75)" />;
  if (status === 'SENT') return <Check size={14} color="rgba(255,255,255,0.75)" />;
  return <Clock size={12} color="rgba(255,255,255,0.6)" />;
}

const locationStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minWidth: 200, maxWidth: 240 },
  iconWrap: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  textWrap: { flex: 1 },
  title: { fontSize: 14, fontWeight: '600' },
  subtitle: { fontSize: 11, marginTop: 1 },
});

const mediaStyles = StyleSheet.create({
  container: { gap: spacing.xs },
  caption: { fontSize: 12, fontWeight: '600' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  visualTile: { width: 132, height: 132, borderRadius: 12, overflow: 'hidden', backgroundColor: 'rgba(0,0,0,0.08)' },
  visualImage: { width: '100%', height: '100%' },
  placeholder: { alignItems: 'center', justifyContent: 'center' },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minWidth: 180 },
  fileIconWrap: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  fileTextWrap: { flex: 1 },
  fileName: { fontSize: 13, fontWeight: '600' },
  fileMeta: { fontSize: 11, marginTop: 1 },
});

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      justifyContent: 'flex-start',
      paddingHorizontal: spacing.md,
      marginVertical: 3,
    },
    rowMine: {
      justifyContent: 'flex-end',
    },
    bubble: {
      maxWidth: 320,
      borderRadius: radius.card,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    bubbleMine: {
      borderBottomRightRadius: 4,
    },
    bubbleTheirs: {
      backgroundColor: colors.surfaceStrong,
      borderWidth: 1,
      borderColor: colors.border,
      borderBottomLeftRadius: 4,
    },
    sender: { fontSize: 12, fontWeight: '700', color: colors.accent, marginBottom: 2 },
    linkMine: { color: '#ffffff', textDecorationLine: 'underline', fontWeight: '600' },
    linkTheirs: { color: colors.accent, textDecorationLine: 'underline', fontWeight: '600' },
    textMine: {
      color: colors.accentFg,
      fontSize: 15,
      lineHeight: 20,
    },
    textTheirs: {
      color: colors.fg,
      fontSize: 15,
      lineHeight: 20,
    },
    meta: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: 4,
      marginTop: 2,
    },
    timeMine: {
      fontSize: 11,
      color: 'rgba(255,255,255,0.8)',
    },
    timeTheirs: {
      fontSize: 11,
      color: colors.muted,
    },
    tombstone: {
      backgroundColor: colors.surface2,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.card,
    },
    tombstoneText: {
      fontSize: 13,
      fontStyle: 'italic',
      color: colors.muted,
    },
  });
}
