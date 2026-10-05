import { Alert } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { parseChatEnvelope, readablePrefix } from '@taskboard/app/chatEnvelope';

/** The copyable text of a message, or null when there is none (a location card, media, a tombstone). */
export function copyableText(body: string, deletedForAll?: boolean): string | null {
  if (deletedForAll) return null;
  const envelope = parseChatEnvelope(body);
  if (envelope) return envelope.kind === 'fileOffer' ? readablePrefix(body) || null : null;
  return body.trim() ? body : null;
}

export async function copyMessageText(text: string): Promise<void> {
  try {
    await Clipboard.setStringAsync(text);
  } catch {
    Alert.alert("Couldn't copy", 'Please try again.');
  }
}
