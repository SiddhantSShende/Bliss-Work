import { EmojiPicker } from './EmojiPicker';
import { Modal } from './Modal';

interface EmojiPickerModalProps {
  visible: boolean;
  onClose: () => void;
  onSelect: (emoji: string) => void;
}

/** The "+" in a message's quick-react row — the existing `EmojiPicker` strip
 *  (otherwise only used inline under the Composer) on the shared `Modal`
 *  sheet, for a react-any-emoji picker without a second emoji set to
 *  maintain. */
export function EmojiPickerModal({ visible, onClose, onSelect }: EmojiPickerModalProps) {
  return (
    <Modal visible={visible} onClose={onClose} title="React with">
      <EmojiPicker
        onSelect={(emoji) => {
          onSelect(emoji);
          onClose();
        }}
      />
    </Modal>
  );
}
