import { useMemo, useState } from 'react';
import { Building2, ChevronRight } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSession } from '@taskboard/app/store/session';
import { useMyOrgs } from '../../hooks/useMyOrgs';
import { Card } from '../../components/Card';
import { OrgSwitcherSheet } from '../../components/OrgSwitcherSheet';
import { spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';

/**
 * The workspace switcher — a card on the More tab's landing screen
 * (MoreMenuScreen) that opens OrgSwitcherSheet (see its own doc for the real
 * `api.myOrgs()`/`api.switchOrg()` switching logic, shared with the Home
 * workspace card so there is exactly one switcher implementation).
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
  const [open, setOpen] = useState(false);

  const label = user?.orgName || orgs.find((o) => o.active)?.orgName || 'Workspace';
  const canSwitch = orgs.length > 1;

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

      <OrgSwitcherSheet visible={open} onClose={() => setOpen(false)} />
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
  });
}
