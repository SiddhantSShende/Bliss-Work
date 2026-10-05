import { MailBox } from '../mail/MailBox';

/** The Mail tab inside Chats — the full mailbox (folders, compose, delete, favourites). */
export function MailTabView({ navigation, query }: { navigation: any; query?: string }) {
  return <MailBox navigation={navigation} query={query} />;
}
