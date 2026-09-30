// Photos are shrunk in the browser before upload (SPEC 5), so the free tier never
// pays for image processing and uploads stay small on mobile data.

const MAX_EDGE = 1600;
const MAX_BYTES = 5 * 1024 * 1024;

export async function compressImage(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('That file is not a photo.');
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error('This photo format is not supported. Try a JPEG or PNG.');
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  for (const q of [0.82, 0.7, 0.55]) {
    const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/webp', q));
    // Safari without WebP encoding falls back to PNG; use JPEG instead.
    const out = blob && blob.type === 'image/webp' ? blob : await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/jpeg', q));
    if (out && out.size <= MAX_BYTES) return out;
  }
  throw new Error('This photo is too large, even after shrinking it.');
}
