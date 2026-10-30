// Viewer settings (look, lights, camera, sound) remembered in this browser.
// Saved values are merged onto the defaults key by key, keeping only values
// of the right type, so settings saved by an older version (or edited by
// hand) can never break the page; anything missing takes its default.
import type { RoomId } from '../audio/AudioEngine';
import { ROOMS } from '../audio/AudioEngine';
import { DEFAULT_FRAMING, type Framing } from '../presentation/CinematicCamera';
import { DEFAULT_LIGHTS, type LightSettings } from '../presentation/Environment';
import { DEFAULT_LOOK, type Look } from '../presentation/SceneRenderer';

export interface SoundSettings {
  reverb: number;
  room: RoomId;
  volume: number;
  muted: boolean;
}

export const DEFAULT_SOUND: SoundSettings = { reverb: 0.3, room: 'parlour', volume: 0.8, muted: false };

export interface Settings {
  look: Look;
  lights: LightSettings;
  framing: Framing;
  sound: SoundSettings;
}

const KEY = 'mechanical-pianist/settings/v1';

function merge<T extends object>(defaults: T, saved: unknown): T {
  const out = { ...defaults };
  if (!saved || typeof saved !== 'object') return out;
  for (const k of Object.keys(defaults) as (keyof T)[]) {
    const v = (saved as Record<string, unknown>)[k as string];
    if (typeof v === typeof defaults[k] && (typeof v !== 'number' || Number.isFinite(v))) out[k] = v as T[keyof T];
  }
  return out;
}

export function loadSettings(): Settings {
  let saved: Partial<Record<keyof Settings, unknown>> = {};
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) saved = JSON.parse(raw);
  } catch {
    /* storage unavailable or unreadable: defaults */
  }
  const sound = merge(DEFAULT_SOUND, saved.sound);
  if (!(sound.room in ROOMS)) sound.room = DEFAULT_SOUND.room;
  return {
    look: merge(DEFAULT_LOOK, saved.look),
    lights: merge(DEFAULT_LIGHTS, saved.lights),
    framing: merge(DEFAULT_FRAMING, saved.framing),
    sound,
  };
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode or storage full: settings last for this visit only */
  }
}
