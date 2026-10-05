import type { UserDTO } from '@taskboard/shared';
import { MemberPickerSheet } from '../../components/MemberPickerSheet';

interface ForwardMessageSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Called with every selected member when Forward is pressed. */
  onForward: (users: UserDTO[]) => void | Promise<unknown>;
}

/** "Forward" from a message's action sheet: the shared multi-select member picker. */
export function ForwardMessageSheet({ visible, onClose, onForward }: ForwardMessageSheetProps) {
  return (
    <MemberPickerSheet
      visible={visible}
      onClose={onClose}
      title="Forward to..."
      confirmLabel={(n) => (n > 1 ? `Forward to ${n}` : 'Forward')}
      onConfirm={onForward}
    />
  );
}
