import { useMemo } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { File as FileIcon, FileArchive, FileSpreadsheet, FileText, Image as ImageIcon } from 'lucide-react-native';
import { extensionOf } from '../lib/attachmentFiles';
import { radius, type ThemeColors } from '../constants/theme';
import { useThemeColors } from '../theme/ThemeProvider';

type Kind = 'image' | 'spreadsheet' | 'document' | 'archive' | 'other';

/** Type is read from the MIME (the server's, once known) with the extension as fallback. */
export function fileKind(mime: string, name: string): Kind {
  const ext = extensionOf(name);
  if (mime.startsWith('image/')) return 'image';
  if (mime.includes('spreadsheet') || mime.includes('excel') || ext === 'csv' || ext === 'xls' || ext === 'xlsx') return 'spreadsheet';
  if (mime.includes('zip') || mime.includes('compressed') || ['zip', 'rar', '7z', 'gz', 'tar'].includes(ext)) return 'archive';
  if (
    mime === 'application/pdf' ||
    mime.startsWith('text/') ||
    mime.includes('word') ||
    mime.includes('presentation') ||
    ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'txt', 'rtf', 'odt'].includes(ext)
  )
    return 'document';
  return 'other';
}

/** "PDF", "DOCX", … for the file-type label; falls back to the MIME subtype. */
export function fileTypeLabel(mime: string, name: string): string {
  const ext = extensionOf(name);
  if (ext) return ext.toUpperCase();
  const sub = mime.split('/')[1];
  return sub && mime !== 'application/octet-stream' ? sub.toUpperCase() : 'FILE';
}

/**
 * The leading square of an attachment row: a thumbnail for a locally picked
 * image, otherwise a glyph for the kind of file.
 */
export function FileGlyph({ mime, name, uri, size = 40 }: { mime: string; name: string; uri?: string; size?: number }) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const kind = fileKind(mime, name);
  const tint = kind === 'spreadsheet' ? colors.success : kind === 'document' ? colors.danger : kind === 'image' ? colors.accent : colors.muted;
  const Icon = kind === 'image' ? ImageIcon : kind === 'spreadsheet' ? FileSpreadsheet : kind === 'archive' ? FileArchive : kind === 'document' ? FileText : FileIcon;
  if (kind === 'image' && uri) {
    return <Image source={{ uri }} style={[styles.box, { width: size, height: size }]} accessibilityIgnoresInvertColors />;
  }
  return (
    <View style={[styles.box, styles.center, { width: size, height: size }]}>
      <Icon size={size * 0.48} color={tint} />
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    box: { borderRadius: radius.card, backgroundColor: colors.surface2 },
    center: { alignItems: 'center', justifyContent: 'center' },
  });
}
