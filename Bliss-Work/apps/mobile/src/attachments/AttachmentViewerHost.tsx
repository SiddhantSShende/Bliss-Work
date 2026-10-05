import { useState } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Download, ExternalLink, FileText, X } from 'lucide-react-native';
import ImageViewer from 'react-native-image-viewing';
import { WebView } from 'react-native-webview';
import { prettySize } from '@taskboard/app/chatEnvelope';
import { spacing } from '../constants/theme';
import { useThemeColors } from '../theme/ThemeProvider';
import { Modal } from '../components/Modal';
import { attachmentViewer, useAttachmentViewer } from './attachmentViewer';

/**
 * The app's ONE attachment viewer — see attachmentViewer.ts for why every
 * tap goes through here instead of each screen building its own. Mounted
 * once in App.tsx, like CallOverlay.
 */
export function AttachmentViewerHost() {
  const state = useAttachmentViewer();
  if (!state) return null;
  if (state.kind === 'image') {
    return (
      <ImageViewer
        images={state.images.map((i) => ({ uri: i.uri }))}
        imageIndex={state.index}
        visible
        onRequestClose={attachmentViewer.close}
        onImageIndexChange={(index) => attachmentViewer.open({ ...state, index })}
        swipeToCloseEnabled
        doubleTapToZoomEnabled
        backgroundColor="#000000"
        presentationStyle="overFullScreen"
      />
    );
  }
  if (state.kind === 'doc') return <DocPreview url={state.url} name={state.name} />;
  return <FileDetailsSheet name={state.name} sizeBytes={state.sizeBytes} mime={state.mime} url={state.url} />;
}

/** PDF/plain-text preview: rendered from our OWN signed URL inside an
 *  embedded WebView surface — not the OS browser, no address bar, no Chrome
 *  tab, nothing navigated to. The URL never leaves the app. */
function DocPreview({ url, name }: { url: string; name: string }) {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  return (
    <View style={[styles.fill, { backgroundColor: '#000' }]}>
      <View style={[styles.docHeader, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={attachmentViewer.close} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close">
          <X size={22} color="#fff" />
        </Pressable>
        <Text style={styles.docTitle} numberOfLines={1}>
          {name}
        </Text>
        <Pressable
          onPress={() => void Linking.openURL(url).catch(() => Alert.alert("Couldn't open this file"))}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Open externally"
        >
          <ExternalLink size={20} color="#fff" />
        </Pressable>
      </View>
      {failed ? (
        <View style={styles.center}>
          <FileText size={40} color="rgba(255,255,255,0.6)" />
          <Text style={styles.errorText}>Couldn't load this file. The link may have expired.</Text>
          <Pressable
            onPress={() => {
              setFailed(false);
              setLoading(true);
            }}
            style={[styles.retryBtn, { backgroundColor: colors.accent }]}
          >
            <Text style={{ color: colors.accentFg, fontWeight: '700' }}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <WebView
          source={{ uri: url }}
          style={styles.fill}
          onLoadEnd={() => setLoading(false)}
          onError={() => {
            setLoading(false);
            setFailed(true);
          }}
          onHttpError={() => {
            setLoading(false);
            setFailed(true);
          }}
          // The preview only ever needs to render the one signed URL it was
          // opened with — anything the document itself tries to navigate to
          // (a link inside a PDF, say) is not part of "previewing this file"
          // and is refused rather than silently taking over the view.
          onShouldStartLoadWithRequest={(req) => req.url === url}
        />
      )}
      {loading && !failed ? (
        <View style={[styles.center, StyleSheet.absoluteFill]} pointerEvents="none">
          <ActivityIndicator color="#fff" size="large" />
        </View>
      ) : null}
    </View>
  );
}

/** The fallback for a file type nothing in-app can render: a small BlissWork
 *  sheet naming it, never a silent automatic browser open. Opening it
 *  externally is one explicit tap away. */
function FileDetailsSheet({ name, sizeBytes, mime, url }: { name: string; sizeBytes: number; mime: string; url: string | undefined }) {
  const colors = useThemeColors();
  return (
    <Modal visible onClose={attachmentViewer.close} title="File">
      <View style={sheetStyles.row}>
        <View style={[sheetStyles.iconWrap, { backgroundColor: colors.accentSoft }]}>
          <FileText size={26} color={colors.accent} />
        </View>
        <View style={sheetStyles.textWrap}>
          <Text style={[sheetStyles.name, { color: colors.fg }]} numberOfLines={2}>
            {name}
          </Text>
          <Text style={[sheetStyles.meta, { color: colors.muted }]}>
            {url ? `${prettySize(sizeBytes)} · ${mime}` : 'Not available'}
          </Text>
        </View>
      </View>
      {url ? (
        <Pressable
          onPress={() => void Linking.openURL(url).catch(() => Alert.alert("Couldn't open this file"))}
          style={[sheetStyles.openBtn, { backgroundColor: colors.accent }]}
          accessibilityRole="button"
        >
          <Download size={16} color={colors.accentFg} />
          <Text style={{ color: colors.accentFg, fontWeight: '700', fontSize: 15 }}>Open externally</Text>
        </Pressable>
      ) : (
        <Text style={[sheetStyles.unavailable, { color: colors.muted }]}>
          This file isn't available to you — it may have been removed, or you may not have access to the conversation it was shared in.
        </Text>
      )}
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, paddingHorizontal: spacing.xl },
  docHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    backgroundColor: 'rgba(0,0,0,0.85)',
  },
  docTitle: { flex: 1, color: '#fff', fontSize: 15, fontWeight: '700', marginHorizontal: spacing.md, textAlign: 'center' },
  errorText: { color: 'rgba(255,255,255,0.85)', fontSize: 14, textAlign: 'center' },
  retryBtn: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: 20 },
});

const sheetStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingBottom: spacing.lg },
  iconWrap: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  textWrap: { flex: 1 },
  name: { fontSize: 16, fontWeight: '700' },
  meta: { fontSize: 13, marginTop: 2 },
  openBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, height: 48, borderRadius: 24, marginBottom: spacing.lg },
  unavailable: { fontSize: 13, lineHeight: 18, marginBottom: spacing.lg },
});
