import type { MediaItem } from '@taskboard/app/chatEnvelope';
import { mediaCaption } from '../attachmentCaption';

const image = (id: string): MediaItem => ({ id, name: `${id}.jpg`, size: 1024, mime: 'image/jpeg' });
const pdf = (id: string): MediaItem => ({ id, name: `${id}.pdf`, size: 2048, mime: 'application/pdf' });

describe('mediaCaption', () => {
  it('the viewer\'s own image reads "You sent an image"', () => {
    expect(mediaCaption([image('a')], true)).toBe('You sent an image');
  });

  it("another user's image reads \"sent an image\" (the sender name is shown separately above it)", () => {
    expect(mediaCaption([image('a')], false)).toBe('sent an image');
  });

  it('a file (own vs. other)', () => {
    expect(mediaCaption([pdf('a')], true)).toBe('You sent a file');
    expect(mediaCaption([pdf('a')], false)).toBe('sent a file');
  });

  it('a video', () => {
    const video: MediaItem = { id: 'v', name: 'clip.mp4', size: 4096, mime: 'video/mp4' };
    expect(mediaCaption([video], false)).toBe('sent a video');
  });

  it('an audio clip', () => {
    const audio: MediaItem = { id: 'a', name: 'voice.m4a', size: 512, mime: 'audio/m4a' };
    expect(mediaCaption([audio], false)).toBe('sent an audio');
  });

  it('multiple images are counted', () => {
    expect(mediaCaption([image('a'), image('b'), image('c')], false)).toBe('sent 3 images');
    expect(mediaCaption([image('a'), image('b')], true)).toBe('You sent 2 images');
  });

  it('a mix of attachment types is counted as files, not images', () => {
    expect(mediaCaption([image('a'), pdf('b')], false)).toBe('sent 2 files');
  });

  it('never shows a raw filename, mime type or storage id — only the human sentence', () => {
    const caption = mediaCaption([image('img-abc123')], false);
    expect(caption).not.toContain('img-abc123');
    expect(caption).not.toContain('image/jpeg');
  });
});
