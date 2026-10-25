import { hue, initials } from '../format.ts';

export function Avatar({ name, group = false, size = 40 }: { name: string; group?: boolean; size?: number }) {
  const h = hue(name);
  return (
    <div
      className="avatar"
      aria-hidden
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        background: `linear-gradient(180deg, hsl(${h} 45% 62%), hsl(${h} 45% 50%))`,
      }}
    >
      {group ? (
        <svg viewBox="0 0 24 24" width={size * 0.55} height={size * 0.55} fill="currentColor">
          <path d="M8 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8 13c-3.3 0-6 1.6-6 3.6V19h12v-2.4C14 14.6 11.3 13 8 13Zm8 0c-.6 0-1.2.1-1.8.2 1.1.9 1.8 2 1.8 3.4V19h6v-2.2c0-2-2.7-3.8-6-3.8Z" />
        </svg>
      ) : (
        <span className="sensitive">{initials(name)}</span>
      )}
    </div>
  );
}
