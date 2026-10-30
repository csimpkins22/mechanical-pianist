// Visual style presets: each sets the light in the room and the grade
// together (camera framing and depth of field are left alone). After picking
// one, every slider is still free; the style is only a starting point.
import { DEFAULT_LIGHTS, type LightSettings } from './Environment';
import { DEFAULT_LOOK, type Look } from './SceneRenderer';

/** the look keys a style sets (the rest belong to the camera) */
export const STYLE_LOOK_KEYS = [
  'exposure',
  'glow',
  'contrast',
  'saturation',
  'warmth',
  'rolloff',
  'fade',
  'accent',
  'bloom',
  'grain',
  'vignette',
  'streaksOn',
  'streaks',
  'letterboxOn',
  'letterbox',
] as const;

export interface VisualStyle {
  id: string;
  name: string;
  blurb: string;
  look: Partial<Look>;
  lights: Partial<LightSettings>;
}

export const STYLES: VisualStyle[] = [
  {
    id: 'golden',
    name: 'Golden hour',
    blurb: 'Late sun through the curtains, warm sepia, deep warm blacks.',
    look: {},
    lights: {},
  },
  {
    id: 'noir',
    name: 'Noir',
    blurb: 'Black and white: hard low light, long shadows, bright blades of sun, heavy grain, scope bars.',
    look: {
      exposure: 0.95,
      contrast: 1.55,
      saturation: 0,
      warmth: 0,
      rolloff: 0.9,
      glow: 0.9,
      bloom: 1.2,
      grain: 1.9,
      vignette: 1.7,
      streaksOn: true,
      streaks: 0.6,
      letterboxOn: true,
      letterbox: 2.39,
    },
    lights: { sun: 1.25, warmth: 0.1, fill: 0.3, rim: 1.5, shaftsOn: true, shafts: 1.2, rakeOn: true, rake: 1.5, rakeAngle: 6, rakeDir: 30 },
  },
  {
    id: 'noir-cyan',
    name: 'Noir, cyan',
    blurb: 'Noir, except the joint lights, which keep their cyan.',
    look: {
      exposure: 0.95,
      contrast: 1.55,
      saturation: 0,
      accent: 1,
      warmth: 0,
      rolloff: 0.9,
      glow: 1.5,
      bloom: 1.4,
      grain: 1.7,
      vignette: 1.7,
      streaksOn: true,
      streaks: 0.9,
      letterboxOn: true,
      letterbox: 2.39,
    },
    lights: { sun: 1.25, warmth: 0.1, fill: 0.3, rim: 1.5, shaftsOn: true, shafts: 1.2, rakeOn: true, rake: 1.5, rakeAngle: 6, rakeDir: 30 },
  },
  {
    id: 'moonlight',
    name: 'Moonlight',
    blurb: 'Night: cold moonbeams through the gaps, blue shadows, the joints glowing brighter.',
    look: {
      exposure: 1.05,
      contrast: 1.2,
      saturation: 0.72,
      warmth: -0.6,
      rolloff: 0.7,
      glow: 1.6,
      bloom: 1.5,
      grain: 1.2,
      vignette: 1.3,
      streaksOn: true,
      streaks: 0.9,
      letterboxOn: false,
    },
    lights: { sun: 0.6, warmth: -0.85, fill: 0.4, rim: 1.7, shaftsOn: true, shafts: 0.9, rakeOn: true, rake: 0.55, rakeAngle: 12, rakeDir: 25 },
  },
  {
    id: 'faded',
    name: 'Faded film',
    blurb: 'An old print: lifted blacks, soft contrast, muted colour, heavy grain, flat 1.85 bars.',
    look: {
      exposure: 1.05,
      contrast: 0.98,
      saturation: 0.6,
      warmth: 0.7,
      rolloff: 1.2,
      fade: 0.75,
      glow: 0.8,
      bloom: 1.4,
      grain: 2.3,
      vignette: 1.9,
      streaksOn: false,
      letterboxOn: true,
      letterbox: 1.85,
    },
    lights: { sun: 1.1, warmth: 0.85, fill: 1.0, rim: 0.6, shaftsOn: true, shafts: 0.5, rakeOn: false },
  },
  {
    id: 'studio',
    name: 'Studio',
    blurb: 'Clean product light: bright, neutral, soft shadows, no haze.',
    look: {
      exposure: 1.15,
      contrast: 1.05,
      saturation: 0.95,
      warmth: 0.05,
      rolloff: 0.4,
      glow: 1.0,
      bloom: 0.7,
      grain: 0.4,
      vignette: 0.6,
      streaksOn: false,
      letterboxOn: false,
    },
    lights: { sun: 0.6, warmth: 0.1, fill: 2.2, rim: 1.5, shaftsOn: false, rakeOn: false },
  },
];

/** the full look and light settings for a style */
export function styleSettings(style: VisualStyle, current: Look): { look: Look; lights: LightSettings } {
  const look = { ...current };
  for (const k of STYLE_LOOK_KEYS) (look as Record<string, unknown>)[k] = (style.look as Record<string, unknown>)[k] ?? DEFAULT_LOOK[k];
  return { look, lights: { ...DEFAULT_LIGHTS, ...style.lights } };
}
