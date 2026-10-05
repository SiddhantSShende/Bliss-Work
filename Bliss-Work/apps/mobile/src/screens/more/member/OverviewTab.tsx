import { useMemo } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { useSession } from '@taskboard/app/store/session';
import { relativeTime } from '@taskboard/app/lib/relativeTime';
import type { MemberActivityDTO, MemberDTO } from '@taskboard/shared';
import { Card } from '../../../components/Card';
import { spacing } from '../../../constants/theme';
import { InfoRow, Pill, roleLabel, statusLabel, statusTone } from './memberUi';

/**
 * Only fields the backend actually has: MemberDTO (auth-svc roster) plus the
 * telemetry roster row for last seen. There is no department/team or phone on
 * any member DTO, so those rows do not exist here rather than showing blanks.
 */
export function OverviewTab({ member, activity, isSelf }: { member: MemberDTO; activity?: MemberActivityDTO; isSelf: boolean }) {
  const orgName = useSession((s) => s.user?.orgName);

  const lastSeen = useMemo(() => {
    if (isSelf) return 'Now';
    return activity?.lastSeenAt ? relativeTime(activity.lastSeenAt) : 'No recent activity';
  }, [activity?.lastSeenAt, isSelf]);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Card>
        <InfoRow label="Email" value={member.email} />
        <InfoRow label="Username" value={`@${member.username}`} />
        <InfoRow label="Role" value={roleLabel(member.roles)} />
        <InfoRow label="Status" value={<Pill label={statusLabel(member.status)} tone={statusTone(member.status)} />} />
        <InfoRow label="Last seen" value={lastSeen} />
        {activity?.lastLoginAt ? <InfoRow label="Last sign-in" value={new Date(activity.lastLoginAt).toLocaleString()} /> : null}
        <InfoRow label="Email verified" value={member.emailVerified ? 'Yes' : 'Not yet'} />
        {orgName ? <InfoRow label="Workspace" value={orgName} /> : null}
        {member.createdAt ? <InfoRow label="Joined" value={new Date(member.createdAt).toLocaleDateString()} last={!member.removedAt} /> : null}
        {member.removedAt ? <InfoRow label="Removed" value={new Date(member.removedAt).toLocaleString()} last /> : null}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: spacing['2xl'] },
});
