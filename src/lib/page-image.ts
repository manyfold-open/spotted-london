// For a page that names no picture in its head (no og:image): the first big picture in the page's own content,
// the one after the page's main heading. Pure text work on the HTML the backfill has already read, no extra fetch.
// Only the photo backfill uses it: a header, a menu or a footer picture is never this event's, so we start at the
// first <h1> and stop at the footer, and skip logos, icons, tiny pictures, GIFs and SVGs.

// Maps: a venue page's "how to find us" picture is never the event's photo. Google's static map and tile hosts, and a name,
// class or alt that holds the word map on its own ("Map of the venue", venue_map.png), but not "Mapplethorpe" or "mapbox".
const BAD_NAME = /(logo|favicon|sprite|placeholder|icon|avatar|badge|flag|arrow|pixel|spacer|loading|blank|gmap|navigation|\/maps?\/|maps\.googleapis|maps\.gstatic|google\.[a-z.]+\/maps|staticmap|(^|[^a-z])maps?([^a-z]|$))/i;
const GOOD_TYPE = /\.(jpe?g|png|webp)(\?|#|$)/i;
const MAX_TAGS = 25;
const MIN_WIDTH = 400;

function attr(tag: string, name: string): string {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return (m?.[1] ?? m?.[2] ?? '').trim();
}

/** The widest candidate of a srcset: "a.jpg 300w, b.jpg 900w" gives b.jpg. */
function widest(srcset: string): { url: string; width: number } | null {
  let best: { url: string; width: number } | null = null;
  for (const part of srcset.split(/,\s+/)) {
    const [url, size] = part.trim().split(/\s+/);
    const width = /w$/i.test(size ?? '') ? parseInt(size, 10) : 0;
    if (url && (!best || width > best.width)) best = { url, width };
  }
  return best;
}

export function bodyImage(html: string): string | null {
  const from = html.search(/<h1[\s>]/i);
  if (from < 0) return null; // no main heading: we cannot tell the page's content from its chrome
  const footer = html.slice(from).search(/<footer[\s>]/i);
  const text = footer >= 0 ? html.slice(from, from + footer) : html.slice(from);
  let seen = 0;
  for (const m of text.matchAll(/<img\s[^>]*>/gi)) {
    if (++seen > MAX_TAGS) break;
    const tag = m[0];
    const set = widest(attr(tag, 'srcset') || attr(tag, 'data-srcset'));
    const url = set?.url || attr(tag, 'data-src') || attr(tag, 'data-lazy-src') || attr(tag, 'data-original') || attr(tag, 'src');
    if (!url || /^data:/i.test(url) || !GOOD_TYPE.test(url)) continue;
    if (BAD_NAME.test(url.split('?')[0]) || BAD_NAME.test(attr(tag, 'class')) || BAD_NAME.test(attr(tag, 'alt'))) continue;
    const width = set?.width || parseInt(attr(tag, 'width'), 10) || 0;
    if (width && width < MIN_WIDTH) continue; // a width we can read and it is small: a thumbnail, a button
    return url;
  }
  return null;
}

/** Width and height from the first bytes of a JPEG, PNG or WebP, or null. Reads headers only, no decoding. */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  const u16 = (i: number) => (b[i] << 8) | b[i + 1];
  if (b[0] === 0x89 && b[1] === 0x50) return b.length > 24 ? { width: ((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]), height: (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23] } : null;
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: u16(i + 5), width: u16(i + 7) };
      i += 2 + u16(i + 2);
    }
    return null;
  }
  if (b[0] === 0x52 && b[8] === 0x57 && b.length > 30) {
    const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (kind === 'VP8X') return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (kind === 'VP8L') { const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return { width: 1 + (v & 0x3fff), height: 1 + ((v >> 14) & 0x3fff) }; }
    if (kind === 'VP8 ') return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
  }
  return null;
}

/** A picture from the page body counts as the event's photo only when it is big and not a strip (banners, ads, logos). */
export function looksLikeAPhoto(size: { width: number; height: number } | null): boolean {
  return !!size && size.width >= 400 && size.height >= 250 && size.width / size.height <= 3 && size.height / size.width <= 3;
}
