import { Alert } from 'react-native';
import { LogOut, Pin, PinOff, Trash2 } from 'lucide-react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { errorText } from '@taskboard/app/lib/errorText';
import { qk } from '../../hooks/queryKeys';
import { toggleChannelPin, usePinnedThreads } from '../../lib/pinnedThreads';
import { Modal } from '../../components/Modal';
import { MenuItem } from '../../components/MenuItem';

interface ChannelListRowMenuProps {
  visible: boolean;
  onClose: () => void;
  channelId: string;
}

/**
 * The three-dot menu on a Channels-list row: pin/clear/leave — a joined
 * channel only (the list never shows this menu for one you haven't joined,
 * same as `more/ChannelRowMenu.tsx`'s "Leave Channel", the in-conversation
 * header equivalent this deliberately doesn't touch).
 *
 * No Ignore or Block here: those are 1:1-DM-only endpoints
 * (`ignoreConversation`, `blockUser` — packages/shared/src/api/client.ts has
 * no channel equivalent of either), so this menu only offers what's real for
 * a channel. `clearChannel` mirrors web's ChannelView.tsx exactly (same
 * mutation, same cache invalidation) — mobile just never wired it into the
 * list before. Pin is device-local, same as ChatRowMenu's (see
 * pinnedThreads.ts).
 */
export function ChannelListRowMenu({ visible, onClose, channelId }: ChannelListRowMenuProps) {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const { isChannelPinned } = usePinnedThreads();
  const pinned = isChannelPinned(channelId);

  const clear = useMutation({
    mutationFn: () => api.clearChannel(channelId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.channelMessages(channelId) });
      void qc.invalidateQueries({ queryKey: qk.channels });
    },
    onError: (e: unknown) => Alert.alert('Could not clear this channel', errorText(e)),
  });
  const leave = useMutation({
    mutationFn: () => api.leaveChannel(channelId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.channels }),
    onError: (e: unknown) => Alert.alert('Could not leave the channel', errorText(e)),
  });

  const run = (mutate: () => void) => {
    mutate();
    onClose();
  };

  return (
    <Modal visible={visible} onClose={onClose} title="Channel options">
      <MenuItem icon={pinned ? PinOff : Pin} label={pinned ? 'Unpin' : 'Pin'} onPress={() => run(() => toggleChannelPin(channelId))} />
      <MenuItem icon={Trash2} label="Clear chat" onPress={() => run(() => clear.mutate())} />
      <MenuItem icon={LogOut} danger label="Leave Channel" onPress={() => run(() => leave.mutate())} divider={false} />
    </Modal>
  );
}
