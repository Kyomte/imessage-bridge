import { useEffect, useState } from 'react';
import type { AttachmentInfo } from '@imb/shared';
import { mediaUrl } from '../api.ts';
import { fileSize } from '../format.ts';
import { fitSize, lightbox, useLightbox, useMediaToken, useRefreshMediaToken } from '../media.ts';

const THUMB_MAX_W = 260;
const THUMB_MAX_H = 320;
const STICKER_MAX = 140;

const KIND_LABEL: Record<AttachmentInfo['kind'], string> = {
  image: 'Photo',
  video: 'Video',
  audio: 'Audio',
  file: 'File',
};

function Chip({ attachment: a, note, href }: { attachment: AttachmentInfo; note: string; href?: string }) {
  const body = (
    <>
      <span className="attachment-kind">{a.isSticker ? 'Sticker' : KIND_LABEL[a.kind]}</span>
      <span className="attachment-name sensitive">{a.name}</span>
      <span className="attachment-size">{note}</span>
    </>
  );
  return href ? (
    <a className="attachment" href={href} download={a.name}>
      {body}
    </a>
  ) : (
    <div className="attachment unavailable">{body}</div>
  );
}

export function AttachmentView({ attachment: a }: { attachment: AttachmentInfo }) {
  const token = useMediaToken();
  const refreshToken = useRefreshMediaToken();
  const [failed, setFailed] = useState(false);

  if (!a.available) return <Chip attachment={a} note="Not downloaded on Mac" />;
  if (!token) return <div className="media-placeholder" style={fitSize(a, THUMB_MAX_W, THUMB_MAX_H) ?? undefined} />;
  if (failed) return <Chip attachment={a} note="Couldn't load preview" href={mediaUrl(a.id, 'original', token, true)} />;

  const onError = () => {
    refreshToken();
    setFailed(true);
  };

  if (a.kind === 'image' && a.isSticker) {
    return (
      <img
        className="sticker sensitive"
        src={mediaUrl(a.id, 'thumb', token)}
        alt="Sticker"
        loading="lazy"
        style={fitSize(a, STICKER_MAX, STICKER_MAX) ?? { maxWidth: STICKER_MAX, maxHeight: STICKER_MAX }}
        onError={onError}
      />
    );
  }

  if (a.kind === 'image' || a.kind === 'video') {
    const size = fitSize(a, THUMB_MAX_W, THUMB_MAX_H);
    return (
      <button
        type="button"
        className={`media-thumb ${a.kind}`}
        onClick={() => lightbox.open(a)}
        aria-label={a.kind === 'video' ? `Play video ${a.name}` : `Open photo ${a.name}`}
      >
        <img
          className="sensitive"
          src={mediaUrl(a.id, 'thumb', token)}
          alt=""
          loading="lazy"
          width={size?.width}
          height={size?.height}
          style={size ?? { maxWidth: THUMB_MAX_W, maxHeight: THUMB_MAX_H }}
          onError={onError}
        />
        {a.kind === 'video' && (
          <span className="play-badge" aria-hidden>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          </span>
        )}
      </button>
    );
  }

  if (a.kind === 'audio') {
    return (
      <div className="audio-attachment">
        <audio controls preload="none" src={mediaUrl(a.id, 'preview', token)} onError={onError} />
      </div>
    );
  }

  return <Chip attachment={a} note={`${fileSize(a.size)} · Download`} href={mediaUrl(a.id, 'original', token, true)} />;
}

function LightboxVideo({ src }: { src: string }) {
  const [state, setState] = useState<'preparing' | 'ready' | 'error'>('preparing');
  return (
    <>
      {/* The first play of a video waits while the Mac converts it (~5 s for 30 MB).
          The video stays rendered underneath: a hidden <video> may never load. */}
      <div className="lightbox-video">
        <video
          className="sensitive"
          src={src}
          controls
          autoPlay
          onLoadedData={() => setState('ready')}
          onPlaying={() => setState('ready')}
          onError={() => setState('error')}
          onClick={(e) => e.stopPropagation()}
        />
        {state !== 'ready' && (
          <div className="lightbox-note">
            {state === 'error' ? "This video couldn't be played. Use Download to open it on this PC." : 'Preparing video…'}
          </div>
        )}
      </div>
    </>
  );
}

export function Lightbox() {
  const a = useLightbox();
  const token = useMediaToken();

  useEffect(() => {
    if (!a) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && lightbox.close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [a]);

  if (!a || !token) return null;
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={a.name} onClick={() => lightbox.close()}>
      <div className="lightbox-toolbar" onClick={(e) => e.stopPropagation()}>
        <span className="lightbox-name sensitive">{a.name}</span>
        <a href={mediaUrl(a.id, 'original', token, true)} download={a.name}>
          Download
        </a>
        <button type="button" onClick={() => lightbox.close()}>
          Close
        </button>
      </div>
      <div className="lightbox-body">
        {a.kind === 'video' ? (
          <LightboxVideo key={a.id} src={mediaUrl(a.id, 'preview', token)} />
        ) : (
          <img className="sensitive" src={mediaUrl(a.id, 'preview', token)} alt={a.name} onClick={(e) => e.stopPropagation()} />
        )}
      </div>
    </div>
  );
}
