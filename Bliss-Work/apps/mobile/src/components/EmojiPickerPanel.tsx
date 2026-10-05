import { useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { EMOJI_CATEGORIES } from '../lib/emojiData';
import { rememberEmoji, useRecentEmoji } from '../lib/recentEmoji';
import { SearchInput } from './SearchInput';
import { radius, spacing, type ThemeColors } from '../constants/theme';
import { useThemeColors } from '../theme/ThemeProvider';

const COLUMNS = 8;
const HEADER_H = 30;

type Row = { type: 'header'; key: string; title: string } | { type: 'emoji'; key: string; emojis: readonly string[] };

const ALL = EMOJI_CATEGORIES.flatMap((c) => c.items);

function chunk(list: readonly string[], size: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size) as string[]);
  return out;
}

interface Props {
  onSelect: (emoji: string) => void;
  /** Fixed height of the whole panel. */
  height?: number;
  /** Total horizontal space the host leaves around the panel (padding on both sides). Default: a glass sheet's 2x16. */
  gutter?: number;
}

/**
 * The full Unicode emoji set (generated into lib/emojiData.ts): Recently used,
 * eight categories with a jump bar, and keyword search. Own virtualised grid,
 * so host it in a non-scrolling container (GlassModal `scroll={false}`).
 */
export function EmojiPickerPanel({ onSelect, height = 380, gutter = spacing.lg * 2 }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const recent = useRecentEmoji();
  const [query, setQuery] = useState('');
  const { width: windowWidth } = useWindowDimensions();
  const listRef = useRef<FlatList<Row>>(null);

  // Sheets are capped at 520dp wide (see GlassModal); size the 8-column grid from that, not from a measured layout.
  const cell = Math.floor((Math.min(windowWidth, 520) - gutter) / COLUMNS);

  const { rows, offsets, jumpIndex } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list: Row[] = [];
    const jump: { key: string; label: string; index: number }[] = [];
    if (q) {
      const hits = ALL.filter(([, words]) => words.includes(q)).map(([e]) => e);
      chunk(hits, COLUMNS).forEach((r, i) => list.push({ type: 'emoji', key: `s${i}`, emojis: r }));
      return { rows: list, offsets: [] as number[], jumpIndex: jump };
    }
    if (recent.length) {
      jump.push({ key: 'recent', label: '🕘', index: list.length });
      list.push({ type: 'header', key: 'h-recent', title: 'Recently used' });
      chunk(recent, COLUMNS).forEach((r, i) => list.push({ type: 'emoji', key: `r${i}`, emojis: r }));
    }
    for (const c of EMOJI_CATEGORIES) {
      jump.push({ key: c.key, label: c.items[0]?.[0] ?? '•', index: list.length });
      list.push({ type: 'header', key: `h-${c.key}`, title: c.title });
      chunk(c.items.map(([e]) => e), COLUMNS).forEach((r, i) => list.push({ type: 'emoji', key: `${c.key}${i}`, emojis: r }));
    }
    let y = 0;
    const offs = list.map((r) => {
      const at = y;
      y += r.type === 'header' ? HEADER_H : cell;
      return at;
    });
    return { rows: list, offsets: offs, jumpIndex: jump };
  }, [query, recent, cell]);

  const pick = (emoji: string) => {
    rememberEmoji(emoji);
    onSelect(emoji);
  };

  return (
    <View style={[styles.wrap, { height }]}>
      <SearchInput value={query} onChangeText={setQuery} placeholder="Search emoji" />
      {!query ? (
        <View style={styles.jumpBar}>
          {jumpIndex.map((j) => (
            <Pressable key={j.key} onPress={() => listRef.current?.scrollToOffset({ offset: offsets[j.index] ?? 0, animated: true })} style={styles.jump} accessibilityRole="button">
              <Text style={styles.jumpText}>{j.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <FlatList
        ref={listRef}
        data={rows}
        keyExtractor={(r) => r.key}
        style={styles.list}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={10}
        windowSize={7}
        getItemLayout={(data, index) => {
          const off = offsets[index];
          const r = data?.[index];
          return { length: r?.type === 'header' ? HEADER_H : cell, offset: off ?? index * cell, index };
        }}
        ListEmptyComponent={<Text style={styles.empty}>No emoji match “{query.trim()}”.</Text>}
        renderItem={({ item }) =>
          item.type === 'header' ? (
            <View style={styles.header}>
              <Text style={styles.headerText}>{item.title}</Text>
            </View>
          ) : (
            <View style={[styles.row, { height: cell }]}>
              {item.emojis.map((e) => (
                <Pressable key={e} onPress={() => pick(e)} style={[styles.cell, { width: cell, height: cell }]} accessibilityLabel={`Emoji ${e}`}>
                  <Text style={styles.emoji}>{e}</Text>
                </Pressable>
              ))}
            </View>
          )
        }
      />
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    wrap: { gap: spacing.sm },
    jumpBar: { flexDirection: 'row', justifyContent: 'space-between' },
    jump: { paddingHorizontal: 4, paddingVertical: 2, borderRadius: radius.pill },
    jumpText: { fontSize: 18 },
    list: { flex: 1 },
    header: { height: HEADER_H, justifyContent: 'center' },
    headerText: { fontSize: 12, fontWeight: '700', color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.5 },
    row: { flexDirection: 'row' },
    cell: { alignItems: 'center', justifyContent: 'center' },
    emoji: { fontSize: 26 },
    empty: { textAlign: 'center', color: colors.muted, paddingVertical: spacing.xl },
  });
}
