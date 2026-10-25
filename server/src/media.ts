// Turns attachments into something a Windows browser can show, and caches the result.
//
//   thumb    photo → ≤400 px JPEG; sticker → ≤400 px PNG (keeps transparency);
//            video → poster frame JPEG
//   preview  HEIC/TIFF photo → ≤2048 px JPEG (JPEG/PNG/GIF/WebP as-is);
//            video → H.264 MP4 (H.264 is remuxed, HEVC transcoded with VideoToolbox);
//            CAF/AMR voice message → m4a
//   original the file itself
//
// Attachments are looked up by id only, and the resolved file must live inside the
// Messages Attachments folder. Each conversion runs once: results are cached on disk,
// identical requests in flight share one job, and a small queue limits concurrency.

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs';
import { extname, join, sep } from 'node:path';
import type { Message } from '@imb/shared';
import type { ChatDb } from './chatdb/index.ts';
import type { Store } from './store.ts';

export type Variant = 'thumb' | 'preview' | 'original';
export const VARIANTS: ReadonlySet<string> = new Set<Variant>(['thumb', 'preview', 'original']);

const THUMB_PX = 400;
const PREVIEW_PX = 2048;
const IMAGE_TIMEOUT_MS = 30_000;
const VIDEO_TIMEOUT_MS = 10 * 60_000;
const BROWSER_IMAGES = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const BROWSER_AUDIO = new Set(['.m4a', '.mp3', '.aac', '.wav']);

export interface MediaFile {
  path: string;
  /** Original file name, for downloads. */
  name: string;
}

function run(cmd: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${String(stderr || err.message).trim().slice(0, 300)}`));
      else resolve(stdout);
    });
  });
}

class Limiter {
  #max: number;
  #active = 0;
  #waiting: (() => void)[] = [];

  constructor(max: number) {
    this.#max = max;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#max) await new Promise<void>((resolve) => this.#waiting.push(resolve));
    this.#active++;
    try {
      return await fn();
    } finally {
      this.#active--;
      this.#waiting.shift()?.();
    }
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms).unref());

export class Media {
  #chatDb: ChatDb;
  #store: Store;
  #cacheDir: string;
  #attachmentsRoot: string | null;
  #maxCacheBytes: number;
  #cacheBytes = 0;
  #inFlight = new Map<string, Promise<string>>();
  #images = new Limiter(3);
  #videos = new Limiter(1);

  constructor(
    chatDb: ChatDb,
    store: Store,
    opts: { cacheDir: string; attachmentsRoot: string; maxCacheBytes?: number },
  ) {
    this.#chatDb = chatDb;
    this.#store = store;
    this.#cacheDir = opts.cacheDir;
    this.#maxCacheBytes = opts.maxCacheBytes ?? 5 * 1024 ** 3;
    this.#attachmentsRoot = existsSync(opts.attachmentsRoot) ? realpathSync(opts.attachmentsRoot) : null;
    mkdirSync(this.#cacheDir, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(this.#cacheDir)) this.#cacheBytes += statSync(join(this.#cacheDir, name)).size;
  }

  /** The file to serve for an attachment variant, or null if there's nothing to serve. */
  async get(id: string, variant: Variant): Promise<MediaFile | null> {
    const file = this.#chatDb.attachmentById(id);
    if (!file?.available || !file.path || !this.#attachmentsRoot) return null;
    let path: string;
    try {
      path = realpathSync(file.path);
    } catch {
      return null;
    }
    if (!path.startsWith(this.#attachmentsRoot + sep)) return null;

    const ext = extname(path).toLowerCase();
    const result = (p: string): MediaFile => ({ path: p, name: file.name });
    const imageExt = file.isSticker ? 'png' : 'jpg';

    if (variant === 'original') return result(path);

    if (variant === 'thumb') {
      if (file.kind === 'image') {
        return result(await this.#cached(id, 'thumb', imageExt, this.#images, (out) => this.#image(path, out, THUMB_PX, file.isSticker), true));
      }
      if (file.kind === 'video') {
        return result(await this.#cached(id, 'thumb', 'jpg', this.#images, (out) => this.#poster(path, out), true));
      }
      return null;
    }

    if (file.kind === 'image') {
      if (BROWSER_IMAGES.has(ext)) return result(path);
      return result(await this.#cached(id, 'preview', imageExt, this.#images, (out) => this.#image(path, out, PREVIEW_PX, file.isSticker)));
    }
    if (file.kind === 'video') {
      return result(await this.#cached(id, 'preview', 'mp4', this.#videos, (out) => this.#video(path, out)));
    }
    if (file.kind === 'audio' && !BROWSER_AUDIO.has(ext)) {
      return result(await this.#cached(id, 'preview', 'm4a', this.#images, (out) => this.#audio(path, out)));
    }
    return result(path);
  }

  /**
   * Fills in thumbnail sizes for a page of messages so the client can reserve space.
   * Missing thumbnails are generated, waiting at most budgetMs; the rest finish in the
   * background and are known next time.
   */
  async fillSizes(messages: Message[], budgetMs = 1500): Promise<void> {
    const visual = messages.flatMap((m) => m.attachments).filter((a) => a.available && (a.kind === 'image' || a.kind === 'video'));
    const missing = visual.filter((a) => !this.#store.mediaSize(a.id));
    if (missing.length) {
      const jobs = missing.map((a) => this.get(a.id, 'thumb').catch(() => null));
      await Promise.race([Promise.all(jobs), delay(budgetMs)]);
    }
    for (const a of visual) {
      const size = this.#store.mediaSize(a.id);
      if (size) Object.assign(a, size);
    }
  }

  /** Returns the cached conversion, producing it once if needed. */
  async #cached(
    id: string,
    variant: string,
    ext: string,
    limiter: Limiter,
    produce: (out: string) => Promise<void>,
    recordSize = false,
  ): Promise<string> {
    const key = createHash('sha256').update(id).digest('hex').slice(0, 32);
    const target = join(this.#cacheDir, `${key}-${variant}.${ext}`);
    if (existsSync(target)) {
      const now = new Date();
      utimesSync(target, now, now); // keeps recently used files when evicting
      if (recordSize && !this.#store.mediaSize(id)) await this.#recordSize(id, target);
      return target;
    }

    let job = this.#inFlight.get(target);
    if (!job) {
      job = limiter
        .run(async () => {
          const tmp = `${target}.${randomBytes(4).toString('hex')}.tmp`;
          try {
            await produce(tmp);
            if (!existsSync(tmp)) throw new Error('conversion produced no file');
            renameSync(tmp, target);
          } finally {
            rmSync(tmp, { force: true });
          }
          this.#cacheBytes += statSync(target).size;
          if (recordSize) await this.#recordSize(id, target);
          this.#evict();
          return target;
        })
        .finally(() => this.#inFlight.delete(target));
      this.#inFlight.set(target, job);
    }
    return job;
  }

  async #image(src: string, out: string, px: number, png: boolean) {
    const format = png ? ['-s', 'format', 'png'] : ['-s', 'format', 'jpeg', '-s', 'formatOptions', '82'];
    // sips -Z also enlarges, so only pass it when the image is bigger than px.
    const { width, height } = await this.#pixelSize(src);
    const resize = Math.max(width, height) > px ? ['-Z', String(px)] : [];
    await run('sips', [...format, ...resize, src, '--out', out], IMAGE_TIMEOUT_MS);
  }

  async #pixelSize(path: string): Promise<{ width: number; height: number; orientation: number }> {
    const out = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'orientation', path], IMAGE_TIMEOUT_MS);
    const read = (key: string) => Number(out.match(new RegExp(`${key}: (\\d+)`))?.[1] ?? 0);
    return { width: read('pixelWidth'), height: read('pixelHeight'), orientation: read('orientation') };
  }

  async #poster(src: string, out: string) {
    // ffmpeg applies the rotation tag before scaling, so iw/ih are the displayed size.
    const scale = `scale='if(gt(iw,ih),min(${THUMB_PX},iw),-2)':'if(gt(iw,ih),-2,min(${THUMB_PX},ih))'`;
    for (const seek of ['0.3', '0']) {
      await run('ffmpeg', ['-v', 'error', '-y', '-ss', seek, '-i', src, '-frames:v', '1', '-vf', scale, '-q:v', '4', '-f', 'image2', '-c:v', 'mjpeg', out], IMAGE_TIMEOUT_MS);
      if (existsSync(out) && statSync(out).size > 0) return;
    }
  }

  async #video(src: string, out: string) {
    const codec = (
      await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'default=nw=1:nk=1', src], IMAGE_TIMEOUT_MS)
    ).trim();
    // H.264 plays everywhere, so only rewrap it; anything else (HEVC from iPhones) is
    // transcoded on the Mac's hardware encoder, 8-bit so Windows browsers can decode it.
    const videoArgs = codec === 'h264'
      ? ['-c:v', 'copy']
      : ['-c:v', 'h264_videotoolbox', '-b:v', '6M', '-maxrate', '8M', '-bufsize', '16M', '-pix_fmt', 'yuv420p'];
    await run(
      'ffmpeg',
      ['-v', 'error', '-y', '-i', src, '-map', '0:v:0', '-map', '0:a?', ...videoArgs, '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-f', 'mp4', out],
      VIDEO_TIMEOUT_MS,
    );
  }

  async #audio(src: string, out: string) {
    await run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vn', '-c:a', 'aac', '-b:a', '96k', '-f', 'mp4', out], IMAGE_TIMEOUT_MS);
  }

  /** Stores the thumbnail's displayed size (EXIF orientations 5–8 swap width and height). */
  async #recordSize(id: string, thumb: string) {
    let { width, height, orientation } = await this.#pixelSize(thumb);
    if (!width || !height) return;
    if (orientation >= 5) [width, height] = [height, width];
    this.#store.setMediaSize(id, width, height);
  }

  /** Deletes least recently used cache files once over the cap, down to 90% of it. */
  #evict() {
    if (this.#cacheBytes <= this.#maxCacheBytes) return;
    const files = readdirSync(this.#cacheDir)
      .filter((name) => !name.endsWith('.tmp'))
      .map((name) => {
        const path = join(this.#cacheDir, name);
        const { size, mtimeMs } = statSync(path);
        return { path, size, mtimeMs };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const file of files) {
      if (this.#cacheBytes <= this.#maxCacheBytes * 0.9) break;
      if (this.#inFlight.has(file.path)) continue;
      rmSync(file.path, { force: true });
      this.#cacheBytes -= file.size;
    }
  }
}
