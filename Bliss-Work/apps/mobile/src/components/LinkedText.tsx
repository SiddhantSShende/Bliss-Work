import { useMemo } from 'react';
import { Alert, Linking, Text, type StyleProp, type TextStyle } from 'react-native';
import { useCalls } from '../calls/CallProvider';
import { linkify } from '../lib/linkify';

interface LinkedTextProps {
  text: string;
  style?: StyleProp<TextStyle>;
  linkStyle?: StyleProp<TextStyle>;
}

/**
 * Chat text with tappable URLs. A BlissWork call link (`/call/<id>`, `/join?t=…`
 * or `blisswork://call/…`) is handed to the in-app call layer and never leaves
 * the app; any other link opens through the OS (browser/maps/mail), which is
 * the normal external-link behaviour. Plain text without URLs renders exactly
 * as before.
 */
export function LinkedText({ text, style, linkStyle }: LinkedTextProps) {
  const { openCallLink } = useCalls();
  const segments = useMemo(() => linkify(text), [text]);

  const open = (url: string) => {
    if (openCallLink(url)) return;
    Linking.openURL(url).catch(() => Alert.alert("Couldn't open this link", url));
  };

  return (
    <Text style={style}>
      {segments.map((s, i) =>
        s.url ? (
          <Text key={i} style={linkStyle} onPress={() => open(s.url!)} accessibilityRole="link">
            {s.text}
          </Text>
        ) : (
          s.text
        ),
      )}
    </Text>
  );
}
