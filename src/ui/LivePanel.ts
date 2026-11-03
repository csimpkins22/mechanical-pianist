// The panel while playing live: what the player is playing on, how far behind
// the robot follows, whether the piano sounds at once or with the robot, the
// camera, and a small keyboard that shows the computer keys' layout, lights
// up with whatever is held, and can itself be played (touch screens).
import type { App } from '../app/App';
import { noteName } from '../core/keyboard';
import type { CameraMode } from '../presentation/CinematicCamera';
import { KEYS } from '../live/LiveInput';
import { el, svg } from './dom';

/** a small piano keyboard, for the bar's button */
export const KEYS_ICON =
  '<rect x="3" y="6" width="18" height="12" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8.2 6v12M12 6v12M15.8 6v12" stroke="currentColor" stroke-width="1.3"/><path d="M6.6 6h2.4v6.6H6.6zM10.8 6h2.4v6.6h-2.4zM14.9 6h2.4v6.6h-2.4z"/>';

const CAMS: [CameraMode, string][] = [
  ['cinematic', 'Cinematic'],
  ['follow', 'Follow'],
  ['overhead', 'Overhead'],
  ['macro', 'Macro'],
];

const LOUDNESS = ['pp', 'p', 'mp', 'mf', 'f', 'ff'];

/** the computer keys, left to right: [code, cap, semitone] */
const CAPS: [string, string, number][] = Object.entries(KEYS).map(([code, semi]) => [code, code.replace('Key', '').replace('Semicolon', ';').replace('Quote', "'"), semi]);

export class LivePanel {
  private panel: HTMLDivElement | null = null;
  private device!: HTMLDivElement;
  private info!: HTMLDivElement;
  private keys = new Map<number, HTMLButtonElement>();
  private camBtns = new Map<CameraMode, HTMLButtonElement>();
  private delayVal!: HTMLSpanElement;

  constructor(
    private app: App,
    private root: HTMLElement,
    private ui: { openSettings(): void; closeOverlays(): void },
  ) {
    window.addEventListener('keyup', (e) => {
      if (this.app.live && this.app.live.input.key(e, false)) e.stopPropagation();
    });
    window.addEventListener('blur', () => this.app.live?.input.releaseKeys());
  }

  get active() {
    return !!this.app.live;
  }

  toggle(force?: boolean) {
    const on = force ?? !this.active;
    if (on === this.active) return;
    if (on) {
      this.ui.closeOverlays();
      this.app.enterLive();
      document.body.classList.add('live');
      this.build();
    } else {
      this.app.exitLive();
      document.body.classList.remove('live');
      this.panel?.remove();
      this.panel = null;
    }
  }

  /** keys while live: the piano's, the camera's, Esc; true when used */
  onKey(e: KeyboardEvent): boolean {
    const live = this.app.live;
    if (!live || e.metaKey || e.ctrlKey || e.altKey) return false;
    if (e.key === 'Escape') {
      this.toggle(false);
      return true;
    }
    if (live.input.key(e, true)) return true;
    const cam = { Digit1: 'cinematic', Digit2: 'follow', Digit3: 'overhead', Digit4: 'macro' }[e.code] as CameraMode | undefined;
    if (cam) {
      this.app.setCamera(cam);
      this.sync();
      return true;
    }
    // nothing else while the keyboard is a piano
    return false;
  }

  private build() {
    this.panel?.remove();
    const p = (this.panel = el('div', 'live-panel'));
    p.setAttribute('role', 'region');
    p.setAttribute('aria-label', 'Playing live');
    const head = el('div', 'lv-head');
    const title = el('div', 'lv-title', '<span class="lv-dot" aria-hidden="true"></span><em>Playing live</em>');
    this.device = el('div', 'lv-device');
    const acts = el('div', 'lv-acts');
    const settings = el('button', 'icon', svg('<path d="M4 7h10M18 7h2M4 17h4M12 17h8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="16" cy="7" r="2.2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="10" cy="17" r="2.2" fill="none" stroke="currentColor" stroke-width="1.6"/>'));
    settings.title = 'Light, camera and sound settings';
    settings.setAttribute('aria-label', settings.title);
    settings.onclick = () => this.ui.openSettings();
    const exit = el('button', 'lv-exit', 'Back to the piece');
    exit.title = 'Stop playing live (Esc)';
    exit.onclick = () => this.toggle(false);
    acts.append(settings, exit);
    head.append(title, this.device, acts);

    const row = el('div', 'lv-row');
    const delay = el('label', 'lv-delay');
    const range = el('input') as HTMLInputElement;
    range.type = 'range';
    range.min = '0.2';
    range.max = '1';
    range.step = '0.05';
    range.value = String(this.app.liveSettings.delay);
    this.delayVal = el('span', 'lv-val');
    range.oninput = () => {
      this.app.live?.setDelay(parseFloat(range.value));
      this.sync();
    };
    delay.title = 'How far behind you the robot plays: longer gives it more time to see what is coming';
    delay.append(el('span', '', 'Robot follows'), range, this.delayVal);
    const hear = el('label', 'ph-toggle');
    const sw = el('input', 'switch') as HTMLInputElement;
    sw.type = 'checkbox';
    sw.checked = this.app.liveSettings.hearAtOnce;
    sw.onchange = () => {
      this.app.liveSettings.hearAtOnce = sw.checked;
      if (this.app.live) this.app.live.settings.hearAtOnce = sw.checked;
    };
    hear.title = 'Off: the piano sounds as the robot plays it. On: you hear yourself at once and the robot follows.';
    hear.append(sw, el('span', '', 'Hear my playing at once'));
    const cams = el('div', 'group cams');
    for (const [m, label] of CAMS) {
      const b = el('button', 'seg', label);
      b.onclick = () => {
        this.app.setCamera(m);
        this.sync();
      };
      this.camBtns.set(m, b);
      cams.appendChild(b);
    }
    row.append(delay, hear, cams);

    // the computer keyboard as a piano: white keys in a row, black keys over the gaps
    const kb = el('div', 'lv-keys');
    const whites = CAPS.filter(([, , s]) => ![1, 3, 6, 8, 10, 13, 15].includes(s));
    const white = 100 / whites.length;
    this.keys.clear();
    for (const [code, cap, semi] of CAPS) {
      const black = [1, 3, 6, 8, 10, 13, 15].includes(semi);
      const b = el('button', black ? 'lk black' : 'lk', `<b>${cap}</b><i></i>`);
      b.dataset.code = code;
      const wi = whites.findIndex(([c]) => c === code);
      if (black) {
        const before = whites.filter(([, , s]) => s < semi).length;
        b.style.left = `calc(${before * white}% - ${white * 0.3}%)`;
        b.style.width = `${white * 0.6}%`;
      } else {
        b.style.left = `${wi * white}%`;
        b.style.width = `${white}%`;
      }
      b.tabIndex = -1;
      const midiOf = () => 12 * ((this.app.live?.input.octave ?? 4) + 1) + semi;
      let sounding: number | null = null;
      b.onpointerdown = (e) => {
        e.preventDefault();
        b.setPointerCapture(e.pointerId);
        sounding = midiOf();
        this.app.live?.noteOn(sounding, this.app.live.input.velocity);
      };
      const up = () => {
        if (sounding !== null) this.app.live?.noteOff(sounding);
        sounding = null;
      };
      b.onpointerup = up;
      b.onpointercancel = up;
      this.keys.set(semi, b);
      kb.appendChild(b);
    }
    this.info = el('div', 'lv-info');
    const keysRow = el('div', 'lv-keyrow');
    keysRow.append(kb, this.info);
    p.append(head, row, keysRow);
    this.root.appendChild(p);
    this.sync();
  }

  sync() {
    const live = this.app.live;
    if (!this.panel || !live) return;
    const inp = live.input;
    this.device.textContent =
      inp.midi === 'connected'
        ? `MIDI · ${inp.devices.join(', ')}`
        : inp.midi === 'asking'
          ? 'Looking for a MIDI keyboard…'
          : inp.midi === 'none'
            ? 'No MIDI keyboard connected: play on the computer keyboard'
            : 'MIDI is not available here: play on the computer keyboard';
    this.delayVal.textContent = `${live.settings.delay.toFixed(2)} s`;
    for (const [m, b] of this.camBtns) b.classList.toggle('on', this.app.camView === m);
    const base = 12 * (inp.octave + 1);
    const held = live.performer.heldKeys();
    for (const [semi, b] of this.keys) {
      const midi = base + semi;
      (b.querySelector('i') as HTMLElement).textContent = semi % 12 === 0 ? noteName(midi) : '';
      b.classList.toggle('down', held.has(midi));
    }
    this.info.innerHTML = `<span><kbd>Z</kbd><kbd>X</kbd> octave <b>${inp.octave}</b></span><span><kbd>C</kbd><kbd>V</kbd> loudness <b>${LOUDNESS[inp.loudness]}</b></span><span><kbd>Space</kbd> pedal</span>`;
  }
}
