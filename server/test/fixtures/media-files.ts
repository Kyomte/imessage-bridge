// Generates small real media files with ffmpeg/sips for the media tests.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function haveMediaTools(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('sips', ['--help'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const ffmpeg = (...args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'ignore' });

export interface MediaFiles {
  jpeg: string;
  heic: string;
  sticker: string;
  hevc: string;
  h264: string;
  caf: string;
  pdf: string;
  /** Has spaces, '#' and non-ASCII, to exercise URL and header encoding. */
  oddName: string;
}

export function makeMediaFiles(attachmentsRoot: string): MediaFiles {
  const dir = join(attachmentsRoot, 'ab', '01', 'guid');
  mkdirSync(dir, { recursive: true });
  const at = (name: string) => join(dir, name);

  ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=1200x800', '-frames:v', '1', at('photo.jpg'));
  execFileSync('sips', ['-s', 'format', 'heic', at('photo.jpg'), '--out', at('IMG_0001.HEIC')], { stdio: 'ignore' });
  ffmpeg('-f', 'lavfi', '-i', 'color=c=red@0.4:s=300x300,format=rgba', '-frames:v', '1', at('sticker.png'));
  ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15', '-f', 'lavfi', '-i', 'sine=d=1', '-t', '1',
    '-c:v', 'hevc_videotoolbox', '-tag:v', 'hvc1', '-c:a', 'aac', '-shortest', at('clip-hevc.mov'));
  ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15', '-t', '1', '-c:v', 'h264_videotoolbox', at('clip-h264.mov'));
  // Real voice messages are Opus-in-CAF, which ffmpeg reads but can't write; ALAC-in-CAF stands in.
  ffmpeg('-f', 'lavfi', '-i', 'sine=d=1', '-c:a', 'alac', '-f', 'caf', at('Audio Message.caf'));
  writeFileSync(at('doc.pdf'), '%PDF-1.4\n%fake\n');
  writeFileSync(at('my photo #1 é.jpg'), Buffer.alloc(2048, 7));

  return {
    jpeg: at('photo.jpg'),
    heic: at('IMG_0001.HEIC'),
    sticker: at('sticker.png'),
    hevc: at('clip-hevc.mov'),
    h264: at('clip-h264.mov'),
    caf: at('Audio Message.caf'),
    pdf: at('doc.pdf'),
    oddName: at('my photo #1 é.jpg'),
  };
}

export function probe(path: string, entries: string): string {
  return execFileSync('ffprobe', ['-v', 'error', '-show_entries', entries, '-of', 'default=nw=1:nk=1', path], {
    encoding: 'utf8',
  }).trim();
}

export function sipsProps(path: string): Record<string, string> {
  const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'format', '-g', 'hasAlpha', path], {
    encoding: 'utf8',
  });
  return Object.fromEntries([...out.matchAll(/^\s+(\w+): (.+)$/gm)].map((m) => [m[1], m[2].trim()]));
}
