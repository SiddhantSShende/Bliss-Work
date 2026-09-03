import { useQuery } from '@tanstack/react-query';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { Button } from '../../components/Button';
import { signOut } from '../../services/auth';
import { colors, spacing } from '../../constants/theme';

/**
 * Placeholder landing screen for Phase A — its only job is to prove the
 * whole stack works end to end: RuntimeProvider's ApiClient, an
 * authenticated request (GET /auth/me), and TanStack Query all wired
 * together. Chats/Channels/Tasks/Mail/Meetings tabs replace this in later
 * phases (see the plan's roadmap).
 */
export function HomeScreen() {
  const { api } = useRuntime();
  const { data: user, isLoading, isError, refetch, isRefetching } = useQuery({
    queryKey: ['me'],
    queryFn: () => api.me(),
  });

  return (
    <View style={styles.container}>
      {isLoading ? (
        <ActivityIndicator color={colors.accent} size="large" />
      ) : isError ? (
        <>
          <Text style={styles.error}>Couldn't load your profile.</Text>
          <Button title="Retry" onPress={() => void refetch()} loading={isRefetching} />
        </>
      ) : (
        <>
          <Text style={styles.greeting}>Welcome, {user?.displayName}</Text>
          <Text style={styles.meta}>{user?.email}</Text>
          <Text style={styles.meta}>{user?.orgName}</Text>
        </>
      )}
      <View style={styles.signOut}>
        <Button title="Sign out" variant="ghost" onPress={() => void signOut(api)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    padding: spacing.xl,
    backgroundColor: colors.bg,
  },
  greeting: { fontSize: 20, fontWeight: '700', color: colors.fg },
  meta: { fontSize: 14, color: colors.muted },
  error: { fontSize: 14, color: colors.danger },
  signOut: { position: 'absolute', bottom: spacing['2xl'] },
});
