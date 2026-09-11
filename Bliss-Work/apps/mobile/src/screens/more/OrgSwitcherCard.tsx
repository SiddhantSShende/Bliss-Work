import { useMemo, useState } from 'react';
import { Building2, Check, ChevronRight } from 'lucide-react-native';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { OrgMembershipDTO } from '@taskboard/shared';
import { useSession } from '@taskboard/app/store/session';
import { useMyOrgs } from '../../hooks/useMyOrgs';
import { useSwitchOrg } from '../../hooks/useSwitchOrg';
import { Card } from '../../components/Card';
import { Modal } from '../../components/Modal';
import { SearchInput } from '../../components/SearchInput';
import { Button } from '../../components/Button';
import { radius, spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';

/**
 * The workspace switcher — a card on the More tab's landing screen
 * (MoreMenuScreen) that opens a search + list + Done sheet, built on the
 * shared `Modal` primitive. Real,
 * functional org switching (api.myOrgs()/api.switchOrg(), same as web's
 * OrgSwitcher) — no separate "Team" entity in the domain (confirmed against
 * packages/shared/src/types/domain.ts), only Organizations.
 *
 * "Create / Join Workspace" from the reference spec is deliberately NOT
 * included: creating an org is a multi-step CAPTCHA-gated flow
 * (`api.createOrg`, see packages/app's onboarding), not a one-tap modal
 * action, and there is no self-serve "join by search" API at all — orgs are
 * joined via invite link only (`InvitePage.tsx` on web). Adding either here
 * would mean a button that either does nothing real or half-implements a
 * flow that belongs on its own screen.
 */
export function OrgSwitcherCard() {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const user = useSession((s) => s.user);
  const { data: orgs = [] } = useMyOrgs();
  const { switchOrg, switchingOrgId } = useSwitchOrg();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const label = user?.orgName || orgs.find((o) => o.active)?.orgName || 'Workspace';
  const canSwitch = orgs.length > 1;
  const filtered = orgs.filter((o) => o.orgName.toLowerCase().includes(query.trim().toLowerCase()));

  const close = () => {
    setOpen(false);
    setQuery('');
  };

  return (
    <>
      <Pressable onPress={() => canSwitch && setOpen(true)} disabled={!canSwitch}>
        <Card style={styles.card}>
          <View style={styles.iconWrap}>
            <Building2 size={18} color={colors.accent} />
          </View>
          <View style={styles.text}>
            <Text style={styles.label} numberOfLines={1}>
              {label}
            </Text>
            <Text style={styles.sub}>{canSwitch ? `${orgs.length} organizations` : 'Your workspace'}</Text>
          </View>
          {canSwitch ? <ChevronRight size={18} color={colors.muted} /> : null}
        </Card>
      </Pressable>

      <Modal visible={open} onClose={close} title="Your organizations" maxHeight="75%">
        <View style={styles.searchWrap}>
          <SearchInput value={query} onChangeText={setQuery} placeholder="Search workspace..." />
        </View>
        <FlatList<OrgMembershipDTO>
          data={filtered}
          keyExtractor={(o) => o.orgId}
          style={styles.list}
          renderItem={({ item }) => {
            const active = item.orgId === user?.orgId;
            const switching = switchingOrgId === item.orgId;
            return (
              <Pressable
                disabled={active || switchingOrgId !== null}
                onPress={async () => {
                  await switchOrg(item.orgId);
                  close();
                }}
                style={[styles.row, active && styles.rowActive]}
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
          }}
        />
        <Button title="Done" onPress={close} style={styles.doneBtn} />
      </Modal>
    </>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
    },
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
