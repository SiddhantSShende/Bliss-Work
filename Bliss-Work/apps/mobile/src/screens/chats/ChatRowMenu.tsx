import { Alert } from 'react-native';
import { Ban, EyeOff, Pin, PinOff, Trash2 } from 'lucide-react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { errorText } from '@taskboard/app/lib/errorText';
import { qk } from '../../hooks/queryKeys';
import { toggleChatPin, usePinnedThreads } from '../../lib/pinnedThreads';
import { Modal } from '../../components/Modal';
import { MenuItem } from '../../components/MenuItem';

interface ChatRowMenuProps {
  visible: boolean;
  onClose: () => void;
  conversationId: string;
  peerId: string;
  blockedByMe: boolean;
}

/** The three-dot menu on a chat row: pin/ignore/clear/block. Ignore/clear/block
 *  are real `ApiClient` calls; pin is device-local (see pinnedThreads.ts's own
 *  doc — messaging-svc has no per-reader pin flag), applied instantly since
 *  there is no request to wait on or roll back. `ignoreConversation` is used
 *  (over the newer `ignoreThread`) because `ConversationDTO` carries a
 *  `conversationId`, not a `threadId` — and its own doc comment says it's
 *  "kept working for /chats" specifically for this reason. Failures are
 *  surfaced, not swallowed. */
export function ChatRowMenu({ visible, onClose, conversationId, peerId, blockedByMe }: ChatRowMenuProps) {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const { isChatPinned } = usePinnedThreads();
  const pinned = isChatPinned(conversationId);

  const invalidate = () => void qc.invalidateQueries({ queryKey: qk.conversations });
  const onError = (title: string) => (e: unknown) => Alert.alert(title, errorText(e));
  const ignore = useMutation({ mutationFn: () => api.ignoreConversation(conversationId), onSuccess: invalidate, onError: onError('Could not ignore this chat') });
  const clear = useMutation({ mutationFn: () => api.clearConversation(conversationId), onSuccess: invalidate, onError: onError('Could not clear this chat') });
  const toggleBlock = useMutation({
    mutationFn: () => (blockedByMe ? api.unblockUser(peerId) : api.blockUser(peerId)),
    onSuccess: invalidate,
    onError: onError(blockedByMe ? 'Could not unblock this person' : 'Could not block this person'),
  });

  const run = (mutate: () => void) => {
    mutate();
    onClose();
  };

  return (
    <Modal visible={visible} onClose={onClose} title="Chat options">
      <MenuItem icon={pinned ? PinOff : Pin} label={pinned ? 'Unpin' : 'Pin'} onPress={() => run(() => toggleChatPin(conversationId))} />
      <MenuItem icon={EyeOff} label="Ignore" onPress={() => run(() => ignore.mutate())} />
      <MenuItem icon={Trash2} label="Clear chat" onPress={() => run(() => clear.mutate())} />
      <MenuItem icon={Ban} danger label={blockedByMe ? 'Unblock' : 'Block'} onPress={() => run(() => toggleBlock.mutate())} divider={false} />
    </Modal>
  );
}
