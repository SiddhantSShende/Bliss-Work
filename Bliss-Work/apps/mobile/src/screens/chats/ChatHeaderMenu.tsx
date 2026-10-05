import { Bell, ChevronDown, FileStack, ListChecks, Search, UserRound, type LucideIcon } from 'lucide-react-native';
import { Modal } from '../../components/Modal';
import { MenuItem } from '../../components/MenuItem';

export interface ChatHeaderMenuAnchor {
  top: number;
  right: number;
}

interface ChatHeaderMenuProps {
  visible: boolean;
  /** Ignored: the menu is a centred glass sheet so it can never fall off-screen. Kept so existing callers still compile. */
  anchor?: ChatHeaderMenuAnchor | null;
  onClose: () => void;
  onViewProfile: () => void;
  onSearch: () => void;
  onMediaLinksDocs: () => void;
  onSelectMessages: () => void;
  onMuteNotifications: () => void;
  onMore: () => void;
  /** Swaps the "Mute"/"Unmute" label and icon fill for the current chat. */
  muted: boolean;
}

export function ChatHeaderMenu({
  visible,
  onClose,
  onViewProfile,
  onSearch,
  onMediaLinksDocs,
  onSelectMessages,
  onMuteNotifications,
  onMore,
  muted,
}: ChatHeaderMenuProps) {
  const run = (action: () => void) => {
    onClose();
    action();
  };

  const items: { key: string; label: string; icon: LucideIcon; onPress: () => void }[] = [
    { key: 'profile', label: 'View Profile', icon: UserRound, onPress: onViewProfile },
    { key: 'search', label: 'Search', icon: Search, onPress: onSearch },
    { key: 'media', label: 'Media, Links & Docs', icon: FileStack, onPress: onMediaLinksDocs },
    { key: 'select', label: 'Select Messages', icon: ListChecks, onPress: onSelectMessages },
    { key: 'mute', label: muted ? 'Unmute Notifications' : 'Mute Notifications', icon: Bell, onPress: onMuteNotifications },
    { key: 'more', label: 'More', icon: ChevronDown, onPress: onMore },
  ];

  return (
    <Modal visible={visible} onClose={onClose} title="Chat">
      {items.map((item, index) => (
        <MenuItem key={item.key} icon={item.icon} label={item.label} divider={index < items.length - 1} onPress={() => run(item.onPress)} />
      ))}
    </Modal>
  );
}
