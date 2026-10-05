import { useMemo, useState } from 'react';
import { Building2, Check } from 'lucide-react-native';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSession } from '@taskboard/app/store/session';
import { useMyOrgs } from '../hooks/useMyOrgs';
import { useSwitchOrg } from '../hooks/useSwitchOrg';
import { Modal } from './Modal';
import { SearchInput } from './SearchInput';
import { Button } from './Button';
import { radius, spacing, type ThemeColors } from '../constants/theme';
import { useThemeColors } from '../theme/ThemeProvider';

/**
 * The organization switcher sheet — search + list + Done, on the shared
 * glass `Modal` primitive (real background blur, not a plain transparent
 * overlay; see Modal.tsx's own doc). Shared by both trigger points (the Home
 * workspace card and the More tab's OrgSwitcherCard) so there is exactly one
 * switching implementation, not two: real `api.myOrgs()`/`api.switchOrg()`
 * (useMyOrgs/useSwitchOrg), same as web's OrgSwitcher. No org logo field
 * exists in OrgMembershipDTO (packages/shared/src/types/domain.ts) — every
 * row uses the same Building2 placeholder the trigger cards already use,
 * never a fabricated logo.
 *
 * Switching itself, including failure handling (session stays on the
 * previous org until switchOrg actually succeeds) and duplicate-tap
 * prevention (switchingOrgId disables every other row), lives in
 * useSwitchOrg — this component only renders its state.
 */
export function OrgSwitcherSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const user = useSession((s) => s.user);
  const { data: orgs = [] } = useMyOrgs();
  const { switchOrg, switchingOrgId } = useSwitchOrg();
  const [query, setQuery] = useState('');

  const filtered = orgs.filter((o) => o.orgName.toLowerCase().includes(query.trim().toLowerCase()));

  const close = () => {
    onClose();
    setQuery('');
  };

  return (
    <Modal visible={visible} onClose={close} title="Select Organization" maxHeight="75%">
      <View style={styles.searchWrap}>
        <SearchInput value={query} onChangeText={setQuery} placeholder="Search organizations..." />
      </View>
      <View style={styles.list}>
        {filtered.map((item) => {
          const active = item.orgId === user?.orgId;
          const switching = switchingOrgId === item.orgId;
          return (
            <Pressable
              key={item.orgId}
              disabled={active || switchingOrgId !== null}
              onPress={async () => {
                await switchOrg(item.orgId);
                close();
              }}
              style={[styles.row, active && styles.rowActive]}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
            >
              <View style={styles.iconWrap}>
                <Building2 size={16} color={colors.accent} />
              </View>
              <View style={styles.text}>
                <Text style={styles.label}>{item.orgName}</Text>
                <Text style={styles.sub}>{item.roles.includes('org_admin') ? 'Admin' : 'Member'}</Text>
              </View>
              {switching ? (
                <ActivityIndicator color={colors.accent} size="small" />
              ) : active ? (
                <Check size={18} color={colors.accent} />
              ) : null}
            </Pressable>
          );
        })}
      </View>
      <Button title="Done" onPress={close} style={styles.doneBtn} />
    </Modal>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    iconWrap: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: colors.accentSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    text: {
      flex: 1,
      gap: 2,
    },
    label: {
      fontSize: 15,
      fontWeight: '600',
      color: colors.fg,
    },
    sub: {
      fontSize: 12,
      color: colors.muted,
    },
    searchWrap: { marginBottom: spacing.sm },
    list: { flexGrow: 0 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.sm,
      borderRadius: radius.card,
    },
    rowActive: {
      backgroundColor: colors.accentSoft,
    },
    doneBtn: { marginTop: spacing.md },
  });
}
