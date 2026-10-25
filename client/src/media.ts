// Media links and the lightbox. <img>/<video> can't send the device token, so media
// URLs carry a short-lived media token (server: 24 h; refreshed here every 6 h).

import { useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AttachmentInfo } from '@imb/shared';
import { api } from './api.ts';

const REFRESH_MS = 6 * 60 * 60_000;

export function useMediaToken(): string | null {
  const { data } = useQuery({
    queryKey: ['media-token'],
    queryFn: api.mediaToken,
    staleTime: REFRESH_MS,
    refetchInterval: REFRESH_MS,
  });
  return data?.token ?? null;
}

/** Call when a media request fails; refreshes the token in case it expired. */
export function useRefreshMediaToken(): () => void {
  const client = useQueryClient();
  return () => void client.invalidateQueries({ queryKey: ['media-token'] });
}

/** Fits a thumbnail inside maxW×maxH, keeping its aspect ratio. */
export function fitSize(a: AttachmentInfo, maxW: number, maxH: number): { width: number; height: number } | null {
  if (!a.width || !a.height) return null;
  const scale = Math.min(maxW / a.width, maxH / a.height, 1);
  return { width: Math.round(a.width * scale), height: Math.round(a.height * scale) };
}

// Lightbox state: a tiny external store so any message row can open it.
let open: AttachmentInfo | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const lightbox = {
  open(attachment: AttachmentInfo) {
    open = attachment;
    emit();
  },
  close() {
    open = null;
    emit();
  },
};

export function useLightbox(): AttachmentInfo | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => open,
  );
}
