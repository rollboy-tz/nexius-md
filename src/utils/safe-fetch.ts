// path: src/utils/safe-fetch.ts

import dns from 'node:dns';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { ApiError } from './api.error.js';

/**
 * Why this exists: when a caller gives us an image URL, WE are the one who downloads it. Without
 * these checks, "https://169.254.169.254/..." (cloud metadata), "https://localhost:5432" or any
 * internal service becomes reachable through our server (SSRF).
 *
 * Defences, in layers:
 *  1. URL shape: https only, standard port, no credentials, no internal-looking names
 *  2. Address check at CONNECT time (not before): the address the socket really uses is validated,
 *     which also defeats DNS rebinding (a name that answers "public" first and "private" second)
 *  3. Redirects are followed by hand, each hop re-validated, at most 3
 *  4. Size, time and content limits: only real JPEG/PNG/WebP bytes are accepted
 */

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

export interface SafeImage {
  buffer: Buffer;
  mimetype: 'image/jpeg' | 'image/png' | 'image/webp';
}

/* ---------------------------- forbidden addresses ---------------------------- */

const blocked = new net.BlockList();

const V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, includes the cloud metadata address
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];
const V6: ReadonlyArray<readonly [string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
];

V4.forEach(([address, prefix]) => blocked.addSubnet(address, prefix, 'ipv4'));
V6.forEach(([address, prefix]) => blocked.addSubnet(address, prefix, 'ipv6'));

export function isForbiddenAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address); // IPv4 written inside IPv6
  if (mapped?.[1]) return blocked.check(mapped[1], 'ipv4');

  const family = net.isIP(address);
  if (family === 0) return true; // not an address at all: refuse
  return blocked.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

/** Runs for every connection attempt, on the addresses the socket will actually use. */
const safeLookup = ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
  dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error);

    // One forbidden record poisons the whole name: no "mixed answer" tricks.
    if (addresses.length === 0 || addresses.some((entry) => isForbiddenAddress(entry.address))) {
      return callback(new Error('Destination address is not allowed.'));
    }

    if (options.all) return callback(null, addresses);
    const first = addresses[0];
    return first ? callback(null, first.address, first.family) : callback(new Error('No address.'));
  });
}) as unknown as net.LookupFunction;

const agent = new Agent({
  connect: { lookup: safeLookup, timeout: 5_000 },
  headersTimeout: TIMEOUT_MS,
  bodyTimeout: TIMEOUT_MS,
});

/* -------------------------------- URL checks -------------------------------- */

const reject = (code = 'INVALID_IMAGE_URL', message = 'The image link is not allowed.'): ApiError =>
  ApiError.badRequest(message, code);

/**
 * Shape check with no network access. Used when a message is accepted, so bad links are
 * refused immediately instead of failing minutes later inside the queue.
 */
export function assertSafeImageUrl(raw: string): URL {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) throw reject();

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw reject();
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (url.protocol !== 'https:') throw reject('IMAGE_URL_NOT_HTTPS', 'Image links must use https.');
  if (url.username || url.password) throw reject();
  if (url.port && url.port !== '443') throw reject();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw reject();
  if (net.isIP(host) !== 0 && isForbiddenAddress(host)) throw reject();

  return url;
}

/* -------------------------------- download -------------------------------- */

function detectImage(bytes: Buffer): SafeImage['mimetype'] | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length > 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

export async function fetchImageSafely(rawUrl: string): Promise<SafeImage> {
  let url = assertSafeImageUrl(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response: Awaited<ReturnType<typeof undiciFetch>>;

    try {
      response = await undiciFetch(url, {
        dispatcher: agent,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: 'image/jpeg,image/png,image/webp', 'user-agent': 'Nexius-ImageFetcher/1.0' },
      });
    } catch {
      throw reject('IMAGE_FETCH_FAILED', 'The image could not be downloaded.');
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw reject('IMAGE_FETCH_FAILED', 'The image could not be downloaded.');

      url = assertSafeImageUrl(new URL(location, url).toString()); // every hop is validated again
      continue;
    }

    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw reject('IMAGE_FETCH_FAILED', 'The image could not be downloaded.');
    }

    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > MAX_BYTES) {
      await response.body.cancel();
      throw reject('IMAGE_TOO_LARGE', 'The image is larger than 5 MB.');
    }

    const chunks: Buffer[] = [];
    let total = 0;

    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > MAX_BYTES) throw reject('IMAGE_TOO_LARGE', 'The image is larger than 5 MB.');
      chunks.push(Buffer.from(chunk));
    }

    const buffer = Buffer.concat(chunks);
    // The server's Content-Type is a claim. The first bytes are the proof.
    const mimetype = detectImage(buffer);
    if (!mimetype) throw reject('IMAGE_TYPE_NOT_ALLOWED', 'Only JPEG, PNG or WebP images are accepted.');

    return { buffer, mimetype };
  }

  throw reject('IMAGE_FETCH_FAILED', 'Too many redirects while downloading the image.');
}