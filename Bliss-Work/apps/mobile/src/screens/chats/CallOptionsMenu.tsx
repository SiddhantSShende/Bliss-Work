import { Calendar, Link2, Phone, Video } from 'lucide-react-native';
import { Modal } from '../../components/Modal';
import { MenuItem } from '../../components/MenuItem';

interface CallOptionsMenuProps {
  visible: boolean;
  onClose: () => void;
  onVoiceCall: () => void;
  onVideoCall: () => void;
  onSendCallLink: () => void;
  onScheduleCall: () => void;
}

/** Call options from a chat header. Each entry runs its real handler, then closes. */
export function CallOptionsMenu({ visible, onClose, onVoiceCall, onVideoCall, onSendCallLink, onScheduleCall }: CallOptionsMenuProps) {
  const run = (action: () => void) => {
    action();
    onClose();
  };
  return (
    <Modal visible={visible} onClose={onClose} title="Call">
      <MenuItem icon={Phone} label="Voice Call" onPress={() => run(onVoiceCall)} />
      <MenuItem icon={Video} label="Video Call" onPress={() => run(onVideoCall)} />
      <MenuItem icon={Link2} label="Send Call Link" onPress={() => run(onSendCallLink)} />
      <MenuItem icon={Calendar} label="Schedule Call" onPress={() => run(onScheduleCall)} divider={false} />
    </Modal>
  );
}
