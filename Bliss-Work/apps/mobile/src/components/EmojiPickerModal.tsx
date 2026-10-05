import { useWindowDimensions } from 'react-native';
import { EmojiPickerPanel } from './EmojiPickerPanel';
import { Modal } from './Modal';

interface EmojiPickerModalProps {
  visible: boolean;
  onClose: () => void;
  onSelect: (emoji: string) => void;
}

/** Glass sheet with the full emoji picker — the "+" in a message's quick-react row. */
export function EmojiPickerModal({ visible, onClose, onSelect }: EmojiPickerModalProps) {
  const { height } = useWindowDimensions();
  return (
    <Modal visible={visible} onClose={onClose} title="React with" scroll={false} maxHeight="85%">
      <EmojiPickerPanel
        height={Math.min(440, Math.round(height * 0.55))}
        onSelect={(emoji) => {
          onSelect(emoji);
          onClose();
        }}
      />
    </Modal>
  );
}
