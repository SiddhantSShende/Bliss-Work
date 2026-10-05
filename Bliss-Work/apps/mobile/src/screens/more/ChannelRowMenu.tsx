import { Alert } from 'react-native';
import { LogOut } from 'lucide-react-native';
import { errorText } from '@taskboard/app/lib/errorText';
import { useLeaveChannel } from '../../hooks/useChannels';
import { Modal } from '../../components/Modal';
import { MenuItem } from '../../components/MenuItem';

interface ChannelRowMenuProps {
  visible: boolean;
  onClose: () => void;
  channelId: string;
  onLeft: () => void;
}

export function ChannelRowMenu({ visible, onClose, channelId, onLeft }: ChannelRowMenuProps) {
  const leave = useLeaveChannel();
  return (
    <Modal visible={visible} onClose={onClose} title="Channel options">
      <MenuItem
        icon={LogOut}
        danger
        label="Leave Channel"
        divider={false}
        onPress={() => {
          onClose();
          leave.mutate(channelId, { onSuccess: onLeft, onError: (e) => Alert.alert('Could not leave the channel', errorText(e)) });
        }}
      />
    </Modal>
  );
}
