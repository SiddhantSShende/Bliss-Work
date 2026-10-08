/**
 * The converted PDF, in the browser's own viewer: a `blob:` source, which is what
 * the app's CSP allows on web and desktop (see Lightbox's DocFrame, whose markup
 * this matches). No `sandbox` attribute: a sandboxed frame stops the browser's PDF
 * viewer loading at all. The PDF was generated inside the Office Document
 * Sandbox, never taken from the original file.
 */
export function PdfFrame({ url, name }: { url: string; name: string }) {
  return (
    <iframe
      src={url}
      title={name}
      className="h-full max-h-[85vh] w-full max-w-4xl rounded-lg bg-white"
      onClick={(e) => e.stopPropagation()}
    />
  );
}
