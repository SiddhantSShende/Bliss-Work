import { memo } from 'react';
import { Mic, MicOff, Pin } from 'lucide-react-native';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { VideoTrack } from '@livekit/react-native';
import { Avatar } from '../components/Avatar';
import type { RoomParticipantView } from '../calls/roomController';
import type { StagePlan } from './layout';
import { useMeetingSkin } from './skin';

/**
 * A participant tile: video when their camera is on, otherwise their avatar.
 * Memoised on the fields that change what is drawn (the room recreates the
 * participant list on every speaker/mute event; the track handles inside are
 * cached by the adapter, so an unchanged tile is a cheap skip).
 */
interface TileProps {
  p: RoomParticipantView;
  /** Pixels, or '100%' to fill the parent (the PiP window's size is the system's). */
  width: number | '100%';
  height: number | '100%';
  /** Draw the shared screen instead of the camera. */
  screen?: boolean;
  pinned?: boolean;
  /** A tap: the meeting toggles its controls. */
  onTap?: () => void;
  /** A long press: pin / unpin this person. */
  onPin?: (p: RoomParticipantView) => void;
  /** Big stage tile: larger avatar + label. */
  large?: boolean;
}

function sameTile(a: TileProps, b: TileProps): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.screen === b.screen &&
    a.pinned === b.pinned &&
    a.large === b.large &&
    a.onTap === b.onTap &&
    a.onPin === b.onPin &&
    a.p.identity === b.p.identity &&
    a.p.name === b.p.name &&
    a.p.speaking === b.p.speaking &&
    a.p.micOn === b.p.micOn &&
    a.p.camOn === b.p.camOn &&
    a.p.mirror === b.p.mirror &&
    a.p.videoRef === b.p.videoRef &&
    a.p.screenRef === b.p.screenRef &&
    a.p.sharing === b.p.sharing &&
    a.p.handRaised === b.p.handRaised
  );
}

export const Tile = memo(function Tile({ p, width, height, screen, pinned, onTap, onPin, large }: TileProps) {
  const skin = useMeetingSkin();
  const ref = screen ? p.screenRef : p.camOn ? p.videoRef : undefined;
  return (
    <Pressable
      onPress={onTap}
      onLongPress={onPin ? () => onPin(p) : undefined}
      disabled={!onTap && !onPin}
      accessibilityHint={onPin ? 'Long press to pin' : undefined}
      accessibilityLabel={`${p.isLocal ? 'You' : p.name}${p.micOn ? '' : ', muted'}${p.speaking ? ', speaking' : ''}`}
      style={[
        styles.tile,
        {
          width,
          height,
          backgroundColor: skin.tile,
          borderColor: p.speaking && !screen ? skin.accent : skin.tileBorder,
          borderWidth: p.speaking && !screen ? 2 : StyleSheet.hairlineWidth * 2,
        },
      ]}
    >
      {ref ? (
        <VideoTrack
          trackRef={ref as never}
          style={StyleSheet.absoluteFill}
          objectFit={screen ? 'contain' : 'cover'}
          mirror={p.isLocal && p.mirror !== false && !screen}
        />
      ) : (
        <View style={styles.center}>
          <Avatar name={p.name} size={Math.max(36, Math.min(large ? 112 : 64, (typeof width === 'number' && typeof height === 'number' ? Math.min(width, height) : 180) * 0.42))} />
        </View>
      )}
      <View style={styles.label}>
        {p.micOn ? <Mic size={12} color="#ffffff" /> : <MicOff size={12} color="#f87171" />}
        <Text style={styles.labelText} numberOfLines={1}>
          {screen ? `${p.isLocal ? 'Your' : `${p.name}'s`} screen` : p.isLocal ? `${p.name} (You)` : p.name}
        </Text>
        {p.handRaised && !screen ? (
          <Text style={styles.handEmoji} accessibilityLabel="hand raised">✋</Text>
        ) : null}
      </View>
      {pinned ? (
        <View style={styles.pin}>
          <Pin size={12} color="#ffffff" />
        </View>
      ) : null}
    </Pressable>
  );
}, sameTile);

interface StageProps {
  plan: StagePlan;
  width: number;
  height: number;
  landscape: boolean;
  pinned: string | null;
  /** Tap anywhere on the stage: show / hide the meeting controls. */
  onTap: () => void;
  onTogglePin: (p: RoomParticipantView) => void;
  /** Extra content drawn over the stage (banners, the "alone" hint). */
  overlay?: React.ReactNode;
}

const GAP = 8;
const STRIP_H = 112;

/**
 * The participant area, as in the original design: the main participant
 * (whoever `pickStage` picked — a shared screen, the pinned person, or the
 * active speaker; that selection logic is untouched here) fills the top, and
 * everyone else sits in ONE row of tiles underneath that scrolls sideways —
 * never a multi-row grid, never a vertical list. The row never grows the
 * screen's height: it is a fixed-height strip regardless of how many people
 * are in it, so joining a big meeting never pushes the controls off-screen.
 */
export function MeetingStage({ plan, width, height, landscape, pinned, onTap, onTogglePin, overlay }: StageProps) {
  const { stage, stageIsScreen, others } = plan;

  if (!stage) return <View style={{ width, height }}>{overlay}</View>;

  const hasStrip = others.length > 0;
  const strip = landscape ? { w: 132, h: height } : { w: width, h: STRIP_H };
  const mainW = landscape ? width - strip.w - GAP : width;
  const mainH = landscape ? height : hasStrip ? height - strip.h - GAP : height;
  const thumb = landscape ? { w: strip.w, h: 100 } : { w: 88, h: STRIP_H };

  return (
    // A plain View, not a Pressable: MeetingRoom already has a full-screen tap
    // catcher BEHIND everything for taps on empty space, and every tile below
    // forwards its own taps to `onTap`. Wrapping the horizontal strip's
    // FlatList in a Pressable of its own stole its scroll gesture — a tap
    // ancestor and a native horizontal scroller do not share a touch stream.
    <View style={{ width, height, flexDirection: landscape ? 'row' : 'column', gap: GAP }}>
      <View style={{ width: mainW, height: mainH }}>
        <Tile
          p={stage}
          width={mainW}
          height={mainH}
          screen={stageIsScreen}
          large
          pinned={pinned === stage.identity}
          onTap={onTap}
          onPin={hasStrip ? onTogglePin : undefined}
        />
        {overlay}
      </View>
      {hasStrip ? (
        <FlatList
          horizontal={!landscape}
          data={others}
          keyExtractor={(p) => p.identity}
          style={{ width: strip.w, height: strip.h, flexGrow: 0 }}
          contentContainerStyle={{ gap: GAP }}
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          // The row itself never scrolls vertically (`horizontal` above), and being
          // fixed-height it cannot grow the page either — that is what keeps the
          // whole meeting screen from ever needing a vertical scroll.
          renderItem={({ item }) => (
            <Tile p={item} width={thumb.w} height={thumb.h} pinned={pinned === item.identity} onTap={onTap} onPin={onTogglePin} />
          )}
          initialNumToRender={6}
          windowSize={5}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { borderRadius: 18, overflow: 'hidden' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  label: {
    position: 'absolute',
    left: 8,
    bottom: 8,
    maxWidth: '88%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  labelText: { color: '#ffffff', fontSize: 12, fontWeight: '600', flexShrink: 1 },
  handEmoji: { fontSize: 13, lineHeight: 16 },
  pin: { position: 'absolute', top: 8, right: 8, width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.55)' },
});
