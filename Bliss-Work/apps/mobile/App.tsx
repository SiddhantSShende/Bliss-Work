/**
 * @format
 */

import { StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProviders } from './src/context/AppProviders';
import { ErrorBoundary } from './src/components/ErrorBoundary';
import { RootNavigator } from './src/navigation/RootNavigator';
import { GlassProvider } from './src/components/glass/GlassProvider';
import { CallOverlay } from './src/calls/CallOverlay';
import { AttachmentViewerHost } from './src/attachments/AttachmentViewerHost';
import { ScreenSecurityHost } from './src/security/ScreenSecurityHost';
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
      {/* Real background blur: popups render as siblings of the app inside this provider. */}
      <GlassProvider>
        <RootNavigator />
        {/* Renders nothing itself: publishes the call UI as a GlassProvider layer
            (sibling of the blurred app) so it can blur the app behind it. */}
        <CallOverlay />
        {/* The one image/document/file viewer every attachment tap opens through
            — see attachmentViewer.ts for why there is only ever one. */}
        <AttachmentViewerHost />
        {/* Screenshot-attempt banner + system message for the open chat/channel. */}
        <ScreenSecurityHost />
      </GlassProvider>
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
