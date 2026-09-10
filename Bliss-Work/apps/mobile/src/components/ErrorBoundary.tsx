/**
 * Last-chance React error trap for the mobile app.
 *
 * If a child throws while rendering or committing, React unmounts the whole
 * subtree by default — with nothing above it to catch that, the app goes to
 * a blank screen with no recovery path short of a full restart. Ported from
 * packages/app/src/features/ErrorBoundary.tsx (the web/desktop equivalent),
 * minus its react-router-dom reset-on-navigation behavior — there is no
 * router here to key a reset off of, so this only offers a manual Retry.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
// Fixed to the light palette rather than `useThemeColors()`: this is a class
// component (React error boundaries require componentDidCatch/
// getDerivedStateFromError, which only exist on class components — there's
// no hook equivalent), and App.tsx deliberately mounts it OUTSIDE
// <AppProviders> (so it can catch errors AppProviders itself throws), so
// there is no ThemeProvider above it to read from even if it could.
import { lightColors as colors, radius, spacing } from '../constants/theme';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Something went wrong.</Text>
        <Text style={styles.message}>{error.message || 'An unexpected error occurred.'}</Text>
        <Pressable onPress={this.reset} style={styles.button}>
          <Text style={styles.buttonText}>Retry</Text>
        </Pressable>
      </View>
    );
  }
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
  title: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.fg,
  },
  message: {
    fontSize: 13,
    color: colors.muted,
    textAlign: 'center',
  },
  button: {
    marginTop: spacing.sm,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surface2,
  },
  buttonText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.fg,
  },
});
