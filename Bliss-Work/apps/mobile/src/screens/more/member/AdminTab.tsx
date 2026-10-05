import { useMemo } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRuntime } from '@taskboard/app/lib/runtime';
import type { MemberDTO, Role } from '@taskboard/shared';
import { Card } from '../../../components/Card';
import { qk } from '../../../hooks/queryKeys';
import { spacing, type ThemeColors } from '../../../constants/theme';
import { useThemeColors } from '../../../theme/ThemeProvider';
import { ActionButton, Pill, Section, roleLabel, statusLabel, statusTone } from './memberUi';
import { friendlyError } from '../../../components/QueryState';

type Lifecycle = 'suspend' | 'reactivate' | 'remove';

/**
 * Role + access controls, each one a real auth-svc call (all org_admin-only
 * server-side): PATCH /auth/members/{id}/role, POST .../deactivate,
 * POST .../reactivate, DELETE /auth/members/{id}. Each returns the updated
 * MemberDTO, which replaces the roster row — no optimistic paint, since these
 * are rare, consequential actions and a wrong flash that rolls back is worse
 * than waiting for the server. Per-session sign-out lives on the Sessions tab.
 */
export function AdminTab({ member, isSelf }: { member: MemberDTO; isSelf: boolean }) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { api } = useRuntime();
  const qc = useQueryClient();

  const settled = (m: MemberDTO) => {
    qc.setQueryData<MemberDTO[]>(qk.members, (prev) => (prev ?? []).map((x) => (x.id === m.id ? m : x)));
    void qc.invalidateQueries({ queryKey: qk.directory });
    void qc.invalidateQueries({ queryKey: qk.audit(m.id) });
    void qc.invalidateQueries({ queryKey: qk.memberActiveSessions(m.id) });
  };
  const failed = (e: unknown) => Alert.alert('Action failed', friendlyError(e));

  const role = useMutation({ mutationFn: (r: Role) => api.changeMemberRole(member.id, r), onSuccess: settled, onError: failed });
  const lifecycle = useMutation({
    mutationFn: (a: Lifecycle) =>
      a === 'suspend' ? api.deactivateMember(member.id) : a === 'reactivate' ? api.reactivateMember(member.id) : api.removeMember(member.id),
    onSuccess: settled,
    onError: failed,
  });
  const busy = role.isPending || lifecycle.isPending;

  if (isSelf) {
    return (
      <ScrollView contentContainerStyle={styles.content}>
        <Card>
          <Text style={styles.hint}>
            You can't change your own role or membership. Ask another admin — that rule is what stops the last admin locking everyone,
            including themselves, out of the workspace.
          </Text>
        </Card>
      </ScrollView>
    );
  }

  const isAdmin = member.roles.includes('org_admin');
  const name = member.displayName;

  const confirmRole = () =>
    Alert.alert(
      isAdmin ? 'Demote to member?' : 'Make admin?',
      `Are you sure you want to ${isAdmin ? 'demote' : 'promote'} ${name}? They will be signed out of every device so the new permissions take effect.`,
      [{ text: 'Cancel', style: 'cancel' }, { text: 'Confirm', onPress: () => role.mutate(isAdmin ? 'member' : 'org_admin') }],
    );

  const confirmLifecycle = (a: 'suspend' | 'remove') =>
    Alert.alert(
      a === 'suspend' ? 'Deactivate member?' : 'Remove from workspace?',
      a === 'suspend'
        ? `Are you sure you want to deactivate this member? ${name} will be signed out everywhere and can't sign back in until reactivated. Nothing is deleted.`
        : `Are you sure you want to remove ${name}? They lose access immediately. Everything they wrote stays, and they can be re-invited.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Confirm', style: 'destructive', onPress: () => lifecycle.mutate(a) },
      ],
    );

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Section
        title="Role"
        hint="Admins can invite people, manage members and see the audit trail. Changing a role signs the member out of every device."
      >
        <View style={styles.line}>
          <Pill label={roleLabel(member.roles)} tone={isAdmin ? 'accent' : 'neutral'} />
          <ActionButton
            title={role.isPending ? 'Working...' : isAdmin ? 'Demote to member' : 'Make admin'}
            disabled={busy || member.status !== 'active'}
            onPress={confirmRole}
          />
        </View>
        {member.status !== 'active' ? <Text style={styles.hint}>Reactivate this member before changing their role.</Text> : null}
      </Section>

      <Section
        title="Access"
        hint="Deactivating keeps everything and can be undone at any time. Removing revokes the membership — their messages, tasks and history stay, and they can be re-invited."
      >
        <View style={styles.line}>
          <Pill label={statusLabel(member.status)} tone={statusTone(member.status)} />
        </View>
        <View style={styles.line}>
          {member.status === 'active' ? (
            <>
              <ActionButton title="Deactivate" disabled={busy} onPress={() => confirmLifecycle('suspend')} />
              <ActionButton title="Remove" danger disabled={busy} onPress={() => confirmLifecycle('remove')} />
            </>
          ) : (
            <>
              <ActionButton title={lifecycle.isPending ? 'Working...' : 'Reactivate'} disabled={busy} onPress={() => lifecycle.mutate('reactivate')} />
              {member.status === 'suspended' ? <ActionButton title="Remove" danger disabled={busy} onPress={() => confirmLifecycle('remove')} /> : null}
            </>
          )}
        </View>
      </Section>
    </ScrollView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    content: { padding: spacing.lg, paddingBottom: spacing['2xl'], gap: spacing.md },
    line: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm },
    hint: { fontSize: 13, lineHeight: 18, color: colors.muted },
  });
}
