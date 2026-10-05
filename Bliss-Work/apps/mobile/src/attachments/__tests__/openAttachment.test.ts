import type { MediaItem } from '@taskboard/app/chatEnvelope';
import { attachmentViewer } from '../attachmentViewer';
import { openAttachment, openImageGroup } from '../openAttachment';

const image = (id: string): MediaItem => ({ id, name: `${id}.jpg`, size: 1024, mime: 'image/jpeg' });
const pdf: MediaItem = { id: 'p1', name: 'report.pdf', size: 2048, mime: 'application/pdf' };
const zip: MediaItem = { id: 'z1', name: 'archive.zip', size: 4096, mime: 'application/zip' };
const text: MediaItem = { id: 't1', name: 'notes.txt', size: 128, mime: 'text/plain' };

afterEach(() => attachmentViewer.close());

describe('openAttachment', () => {
  it('an image with a resolved url opens the lightbox', () => {
    openAttachment(image('a'), 'https://signed/a.jpg');
    expect(attachmentViewer.get()).toEqual({ kind: 'image', images: [{ uri: 'https://signed/a.jpg', name: 'a.jpg' }], index: 0 });
  });

  it('a plain-text file with a resolved url opens the in-app doc preview, never Linking.openURL', () => {
    openAttachment(text, 'https://signed/notes.txt');
    expect(attachmentViewer.get()).toEqual({ kind: 'doc', url: 'https://signed/notes.txt', name: 'notes.txt', mime: 'text/plain' });
  });

  // Not "doc": Android's bare WebView has no PDF renderer of its own — it
  // silently downloads instead of showing anything, confirmed on-device — so
  // a PDF gets the details sheet's explicit external-open action instead of
  // a blank in-app screen. (Unlike web's iframe-based preview, unaffected.)
  it('a PDF with a resolved url opens the details sheet, not the WebView doc preview', () => {
    openAttachment(pdf, 'https://signed/report.pdf');
    expect(attachmentViewer.get()).toEqual({ kind: 'details', name: 'report.pdf', sizeBytes: 2048, mime: 'application/pdf', url: 'https://signed/report.pdf' });
  });

  it('an unsupported file type opens the details sheet with an explicit external-open action, not an automatic open', () => {
    openAttachment(zip, 'https://signed/archive.zip');
    expect(attachmentViewer.get()).toEqual({ kind: 'details', name: 'archive.zip', sizeBytes: 4096, mime: 'application/zip', url: 'https://signed/archive.zip' });
  });

  it('a missing url (still resolving / not available) opens the details sheet instead of doing nothing', () => {
    openAttachment(image('a'), undefined);
    expect(attachmentViewer.get()).toMatchObject({ kind: 'details', url: undefined });
  });
});

describe('openImageGroup', () => {
  it('opens every image in the message as one swipeable set, starting on the one tapped', () => {
    const items = [image('a'), image('b'), image('c')];
    const urls: Record<string, string> = { a: 'https://s/a.jpg', b: 'https://s/b.jpg', c: 'https://s/c.jpg' };
    openImageGroup(items, (i) => urls[i.id], items[1]!);
    expect(attachmentViewer.get()).toEqual({
      kind: 'image',
      images: [
        { uri: 'https://s/a.jpg', name: 'a.jpg' },
        { uri: 'https://s/b.jpg', name: 'b.jpg' },
        { uri: 'https://s/c.jpg', name: 'c.jpg' },
      ],
      index: 1,
    });
  });

  it('skips an image whose url has not resolved yet, from both the set and the index count', () => {
    const items = [image('a'), image('b'), image('c')];
    const urls: Record<string, string | undefined> = { a: 'https://s/a.jpg', b: undefined, c: 'https://s/c.jpg' };
    openImageGroup(items, (i) => urls[i.id], items[2]!);
    expect(attachmentViewer.get()).toEqual({
      kind: 'image',
      images: [
        { uri: 'https://s/a.jpg', name: 'a.jpg' },
        { uri: 'https://s/c.jpg', name: 'c.jpg' },
      ],
      index: 1,
    });
  });

  it('a non-image in the same group (mixed message) never lands in the lightbox', () => {
    const items = [image('a'), pdf];
    openImageGroup(items, () => 'https://s/x', pdf);
    // pdf itself was tapped but isn't a visual — falls through to openAttachment.
    expect(attachmentViewer.get()).toMatchObject({ kind: 'details' });
  });
});
