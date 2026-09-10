/**
 * @format
 */

import { StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProviders } from './src/context/AppProviders';
import { ErrorBoundary } from './src/components/ErrorBoundary';
import { RootNavigator } from './src/navigation/RootNavigator';
import { useAppTheme } from './src/theme/ThemeProvider';

/**
 * Split out from App() so it renders INSIDE AppProviders — useAppTheme()
 * needs ThemeProvider above it in the tree. Deliberately reads OUR OWN
 * dark-mode setting, not the OS's `useColorScheme()` — same choice web's
 * ThemeProvider already makes (see its own doc comment): the app's
 * appearance is a user preference set inside Settings/More, never inherited
 * from the device.
 */
function AppContent() {
  const { isDark } = useAppTheme();
  return (
    <>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      <RootNavigator />
    </>
  );
}

function App() {
  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <AppProviders>
          <AppContent />
        </AppProviders>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}

export default App;
