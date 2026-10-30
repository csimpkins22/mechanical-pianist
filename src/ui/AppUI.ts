// The interface: a quiet translucent control bar, a title card, and an
// optional drawer for fingering corrections, look and debugging. Plain DOM.
import { FRAME_STEP, SPEEDS, type App, type DemoId } from '../app/App';
import { noteName } from '../core/keyboard';
import type { Finger, Hand, PerformanceNote, TrackInfo } from '../core/types';
import type { ParsedMidi } from '../interpretation/MidiEngine';
import type { CameraMode } from '../presentation/CinematicCamera';
import { DEFAULT_LOOK } from '../presentation/SceneRenderer';
import { DEFAULT_LIGHTS } from '../presentation/Environment';
import { DEFAULT_FRAMING } from '../presentation/CinematicCamera';
import { ROOMS, type RoomId } from '../audio/AudioEngine';
import { DEFAULT_SOUND } from '../app/settings';

const ICON = {
  play: '<path d="M8 5.5v13l11-6.5z"/>',
  pause: '<path d="M7 5h3.6v14H7zM13.4 5H17v14h-3.6z"/>',
  restart: '<path d="M6 6h2v12H6zM9.5 12l8.5 6V6z"/>',
  back: '<path d="M11 12l7 5V7zM6 7h2v10H6z" transform="translate(0 0)"/>',
  fwd: '<path d="M13 12L6 7v10zM16 7h2v10h-2z"/>',
  vol: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15 8.5a5 5 0 010 7M17.5 6a8.5 8.5 0 010 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/>',
  mute: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9.5l5 5M20.5 9.5l-5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  gear: '<path d="M12 8.6a3.4 3.4 0 100 6.8 3.4 3.4 0 000-6.8zm8.2 4.6l1.6 1.2-1.7 3-1.9-.7c-.5.4-1.1.8-1.7 1l-.3 2H12l-.3-2a7 7 0 01-1.7-1l-1.9.7-1.7-3 1.6-1.2a7 7 0 010-2l-1.6-1.2 1.7-3 1.9.7c.5-.4 1.1-.8 1.7-1l.3-2h3.4l.3 2c.6.2 1.2.6 1.7 1l1.9-.7 1.7 3-1.6 1.2a7 7 0 010 2z" transform="translate(-1.5 -1) scale(1.02)"/>',
  open: '<path d="M4 6.5h6l2 2h8v9.5a1 1 0 01-1 1H5a1 1 0 01-1-1z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  loop: '<path d="M7 8h9.5a3 3 0 013 3v.5M17 16H7.5a3 3 0 01-3-3v-.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M14.5 5.5L17 8l-2.5 2.5M9.5 18.5L7 16l2.5-2.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
};

const svg = (p: string) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">${p}</svg>`;

function fmt(t: number) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

export class AppUI {
  private bar!: HTMLDivElement;
  private playBtn!: HTMLButtonElement;
  private timeLabel!: HTMLSpanElement;
  private track!: HTMLDivElement;
  private fill!: HTMLDivElement;
  private handle!: HTMLDivElement;
  private hoverTip!: HTMLDivElement;
  private title!: HTMLDivElement;
  private drawer!: HTMLDivElement;
  private drawerBody!: HTMLDivElement;
  private tab: 'fingering' | 'light' | 'camera' | 'sound' | 'debug' = 'fingering';
  private camBtns: Record<CameraMode, HTMLButtonElement> = {} as never;
  private volBtn!: HTMLButtonElement;
  private loopBtn!: HTMLButtonElement;
  private speedSel!: HTMLSelectElement;
  private demoSel!: HTMLSelectElement;
  private debugInfo!: HTMLDivElement;
  private toastEl!: HTMLDivElement;
  private idleTimer = 0;
  private lastFingerRefresh = -1;

  constructor(private app: App, private root: HTMLElement) {}

  build() {
    const r = this.root;
    r.classList.add('ui');
    // title card
    this.title = el('div', 'title-card');
    r.appendChild(this.title);

    // control bar
    this.bar = el('div', 'bar');
    const scrub = el('div', 'scrub');
    this.track = el('div', 'track');
    this.fill = el('div', 'fill');
    this.handle = el('div', 'handle');
    this.hoverTip = el('div', 'hover-tip');
    this.track.append(this.fill, this.handle, this.hoverTip);
    scrub.appendChild(this.track);
    const row = el('div', 'row');
    const left = el('div', 'group');
    const restart = this.btn(ICON.restart, 'Restart (Home)', () => this.app.restart());
    const back = this.btn(ICON.back, 'Previous frame (←)', () => this.app.step(-1));
    this.playBtn = this.btn(ICON.play, 'Play / pause (Space)', () => this.app.toggle(), 'play');
    const fwd = this.btn(ICON.fwd, 'Next frame (→)', () => this.app.step(1));
    this.timeLabel = el('span', 'time');
    left.append(restart, back, this.playBtn, fwd, this.timeLabel);
    const mid = el('div', 'group cams');
    for (const [m, label] of [
      ['cinematic', 'Cinematic'],
      ['overhead', 'Overhead'],
      ['macro', 'Macro'],
    ] as [CameraMode, string][]) {
      const b = el('button', 'seg', label);
      b.title = `${label} camera (${m === 'cinematic' ? 1 : m === 'overhead' ? 2 : 3})`;
      b.onclick = () => this.app.setMode(m);
      this.camBtns[m] = b;
      mid.appendChild(b);
    }
    const right = el('div', 'group');
    this.speedSel = el('select', 'speed');
    this.speedSel.title = 'Playback speed ([ and ])';
    for (const s of SPEEDS) this.speedSel.appendChild(new Option(`${s}×`, String(s), s === 1, s === 1));
    this.speedSel.onchange = () => this.app.setSpeed(parseFloat(this.speedSel.value));
    this.loopBtn = this.btn(ICON.loop, 'Loop (L)', () => {
      this.app.loop = !this.app.loop;
      this.sync();
    });
    this.volBtn = this.btn(ICON.vol, 'Mute (M)', () => {
      this.app.audio.setMuted(!this.app.audio.muted);
      this.app.settingsChanged();
      this.sync();
    });
    const vol = el('input', 'vol') as HTMLInputElement;
    vol.type = 'range';
    vol.min = '0';
    vol.max = '1';
    vol.step = '0.01';
    vol.value = String(this.app.audio.volume);
    vol.title = 'Volume';
    vol.oninput = () => {
      this.app.audio.setVolume(parseFloat(vol.value));
      this.app.settingsChanged();
    };
    const open = this.btn(ICON.open, 'Open a MIDI file (or drop one anywhere)', () => this.pickFile());
    this.demoSel = el('select', 'demo');
    this.demoSel.title = 'Built-in pieces';
    this.demoSel.append(new Option('Nocturne', 'nocturne'), new Option('Five-note phrase', 'phrase'), new Option('Études (test passages)', 'etudes'), new Option('Your file', 'file'));
    this.demoSel.onchange = () => {
      if (this.demoSel.value === 'file') this.pickFile();
      else this.app.loadDemo(this.demoSel.value as DemoId);
    };
    const gear = this.btn(ICON.gear, 'Fingering, light, camera, sound and debug (A)', () => this.toggleDrawer());
    right.append(this.speedSel, this.loopBtn, this.volBtn, vol, open, this.demoSel, gear);
    row.append(left, mid, right);
    this.bar.append(scrub, row);
    r.appendChild(this.bar);
    this.bindScrub();

    // drawer
    this.drawer = el('div', 'drawer');
    const tabs = el('div', 'tabs');
    for (const [id, label] of [
      ['fingering', 'Fingering'],
      ['light', 'Light'],
      ['camera', 'Camera'],
      ['sound', 'Sound'],
      ['debug', 'Debug'],
    ] as const) {
      const b = el('button', 'tab', label);
      b.dataset.tab = id;
      b.onclick = () => {
        this.tab = id;
        this.renderDrawer();
      };
      tabs.appendChild(b);
    }
    const close = el('button', 'close', '×');
    close.title = 'Close';
    close.onclick = () => this.toggleDrawer(false);
    tabs.appendChild(close);
    this.drawerBody = el('div', 'drawer-body');
    this.drawer.append(tabs, this.drawerBody);
    r.appendChild(this.drawer);

    this.debugInfo = el('div', 'debug-info');
    r.appendChild(this.debugInfo);
    this.toastEl = el('div', 'toast');
    r.appendChild(this.toastEl);

    this.bindDrop();
    this.bindKeys();
    this.bindIdle();
    this.app.on((what) => this.onApp(what));
    this.sync();
    this.renderTitle();
  }

  private btn(icon: string, title: string, fn: () => void, cls = '') {
    const b = el('button', `icon ${cls}`, svg(icon));
    b.title = title;
    b.setAttribute('aria-label', title);
    b.onclick = (e) => {
      e.stopPropagation();
      fn();
    };
    return b;
  }

  private onApp(what: string) {
    if (what === 'piece') {
      this.renderTitle();
      const p = this.app.piece;
      if (p) this.demoSel.value = p.source.kind === 'demo' ? p.source.id : 'file';
      if (p?.perf.warnings.length) this.toast(p.perf.warnings.join(' · '));
      this.lastFingerRefresh = -1;
    }
    if (what === 'quality') this.toast(`Quality lowered to ${this.app.view.post.quality} to keep playback smooth (change it under ⚙ → Look)`, 6000);
    if (what === 'audio') {
      const s = this.app.audio.status;
      if (s === 'loading') this.toast('Tuning the piano…');
      if (s === 'synth') this.toast('Piano samples unavailable: using the built-in synthesized piano');
      if (s === 'samples') this.toast('');
    }
    this.sync();
  }

  sync() {
    const a = this.app;
    const d = a.duration || 1;
    const pk = a.playing ? 'pause' : 'play';
    if (this.playBtn.dataset.icon !== pk) {
      this.playBtn.dataset.icon = pk;
      this.playBtn.innerHTML = svg(a.playing ? ICON.pause : ICON.play);
    }
    this.playBtn.classList.toggle('loading', a.playing && a.audio.status === 'loading');
    this.timeLabel.textContent = `${fmt(a.t)} / ${fmt(d)}`;
    const u = Math.min(1, a.t / d);
    this.fill.style.width = `${u * 100}%`;
    this.handle.style.left = `${u * 100}%`;
    for (const m of Object.keys(this.camBtns) as CameraMode[]) this.camBtns[m].classList.toggle('on', a.mode === m);
    const vk = a.audio.muted ? 'mute' : 'vol';
    if (this.volBtn.dataset.icon !== vk) {
      this.volBtn.dataset.icon = vk;
      this.volBtn.innerHTML = svg(a.audio.muted ? ICON.mute : ICON.vol);
    }
    this.loopBtn.classList.toggle('on', a.loop);
    this.speedSel.value = String(a.speed);
    document.body.classList.toggle('playing', a.playing);
    if (this.drawer.classList.contains('open')) {
      // refresh the fingering list as the playhead moves on (not every frame)
      const bucket = Math.floor(a.t * 2);
      if (this.tab === 'fingering' && bucket !== this.lastFingerRefresh) {
        this.lastFingerRefresh = bucket;
        this.renderDrawer();
      }
    }
    if (a.debug?.visible) this.renderDebugInfo();
    this.debugInfo.style.display = a.debug?.visible ? 'block' : 'none';
  }

  private renderTitle() {
    const p = this.app.piece;
    if (!p) return;
    const approx = p.perf.stats.approximated;
    this.title.innerHTML = `<div class="eyebrow">The Mechanical Pianist</div><div class="name">${escapeHtml(p.perf.score.name)}</div>${
      approx ? `<div class="note">${approx} note${approx === 1 ? '' : 's'} approximated (beyond the robot's reach)</div>` : ''
    }`;
  }

  toast(msg: string, ms = 4200) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.toggle('show', !!msg);
    if (msg) setTimeout(() => this.toastEl.textContent === msg && this.toastEl.classList.remove('show'), ms);
  }

  // ------------------------------------------------------------- scrubbing
  private bindScrub() {
    const at = (e: PointerEvent) => {
      const r = this.track.getBoundingClientRect();
      return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * this.app.duration;
    };
    this.track.addEventListener('pointerdown', (e) => {
      this.track.setPointerCapture(e.pointerId);
      this.app.beginScrub();
      this.app.seek(at(e));
      this.track.classList.add('drag');
    });
    this.track.addEventListener('pointermove', (e) => {
      const t = at(e);
      const r = this.track.getBoundingClientRect();
      this.hoverTip.textContent = fmt(t);
      this.hoverTip.style.left = `${((t / (this.app.duration || 1)) * r.width).toFixed(0)}px`;
      if (this.track.classList.contains('drag')) this.app.seek(t);
    });
    const end = () => {
      if (!this.track.classList.contains('drag')) return;
      this.track.classList.remove('drag');
      this.app.endScrub();
    };
    this.track.addEventListener('pointerup', end);
    this.track.addEventListener('pointercancel', end);
  }

  // ------------------------------------------------------------- files
  private pickFile() {
    const inp = el('input') as HTMLInputElement;
    inp.type = 'file';
    inp.accept = '.mid,.midi,audio/midi,audio/x-midi';
    inp.onchange = () => inp.files?.[0] && this.loadFile(inp.files[0]);
    inp.click();
    if (this.app.piece) this.demoSel.value = this.app.piece.source.kind === 'demo' ? this.app.piece.source.id : 'file';
  }

  private async loadFile(f: File) {
    try {
      const parsed = this.app.readFile(await f.arrayBuffer(), f.name);
      const melodic = parsed.tracks.filter((t) => t.noteCount > 0 && t.instrument !== 'percussion');
      if (!melodic.length) throw new Error('no notes found in this file');
      if (melodic.length > 1) this.trackDialog(parsed, f.name);
      else this.perform(() => this.app.loadParsed(parsed, f.name), parsed.name);
    } catch (e) {
      this.toast(`Could not read ${f.name}: ${e instanceof Error ? e.message : e}`, 6000);
    }
  }

  /** interpretation runs on the main thread: say so before it starts */
  private perform(fn: () => void, name: string) {
    this.toast(`Interpreting ${name}: hands, fingering and motion…`, 60000);
    setTimeout(() => {
      try {
        fn();
        const p = this.app.piece;
        this.toast(p?.perf.warnings.length ? p.perf.warnings.join(' · ') : '', 5000);
      } catch (e) {
        this.toast(`Could not perform ${name}: ${e instanceof Error ? e.message : e}`, 6000);
      }
    }, 40);
  }

  private trackDialog(parsed: ParsedMidi, name: string, current?: number[]) {
    const back = el('div', 'modal-back');
    const box = el('div', 'modal');
    box.innerHTML = `<h3>${escapeHtml(parsed.name)}</h3><p>Choose the parts the pianist should play. Piano parts are selected; two tracks are usually the two hands.</p>`;
    const list = el('div', 'track-list');
    const checks: [TrackInfo, HTMLInputElement][] = [];
    const sel = new Set(current ?? parsed.tracks.filter((t) => t.isPiano).map((t) => t.index));
    if (!sel.size) parsed.tracks.filter((t) => t.noteCount > 0 && t.instrument !== 'percussion').forEach((t) => sel.add(t.index));
    for (const t of parsed.tracks) {
      if (!t.noteCount) continue;
      const row = el('label', 'track-row');
      const cb = el('input') as HTMLInputElement;
      cb.type = 'checkbox';
      cb.checked = sel.has(t.index);
      cb.disabled = t.instrument === 'percussion';
      row.append(cb, el('span', 'tname', escapeHtml(t.name)), el('span', 'tmeta', `${escapeHtml(t.instrument)} · ${t.noteCount} notes · ${noteName(t.minMidi)}–${noteName(t.maxMidi)}`));
      list.appendChild(row);
      checks.push([t, cb]);
    }
    const go = el('button', 'primary', 'Perform');
    go.onclick = () => {
      const tracks = checks.filter(([, c]) => c.checked).map(([t]) => t.index);
      back.remove();
      if (!tracks.length) return;
      this.perform(() => (current ? this.app.selectTracks(tracks) : this.app.loadParsed(parsed, name, tracks)), parsed.name);
    };
    const cancel = el('button', '', 'Cancel');
    cancel.onclick = () => back.remove();
    const actions = el('div', 'actions');
    actions.append(cancel, go);
    box.append(list, actions);
    back.appendChild(box);
    back.onclick = (e) => e.target === back && back.remove();
    this.root.appendChild(back);
  }

  private bindDrop() {
    const over = el('div', 'drop', '<div>Drop a MIDI file to perform it</div>');
    this.root.appendChild(over);
    let depth = 0;
    window.addEventListener('dragenter', (e) => {
      e.preventDefault();
      depth++;
      over.classList.add('show');
    });
    window.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) over.classList.remove('show');
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      over.classList.remove('show');
      const f = e.dataTransfer?.files?.[0];
      if (f) void this.loadFile(f);
    });
  }

  // ------------------------------------------------------------- keys & idle
  private bindKeys() {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).closest('input, select, textarea')) return;
      const a = this.app;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          a.toggle();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (e.shiftKey) a.seek(a.t - 1);
          else a.step(-1);
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (e.shiftKey) a.seek(a.t + 1);
          else a.step(1);
          break;
        case 'Home':
          a.seek(0);
          break;
        case 'End':
          a.seek(a.duration);
          break;
        case '1':
          a.setMode('cinematic');
          break;
        case '2':
          a.setMode('overhead');
          break;
        case '3':
          a.setMode('macro');
          break;
        case 'd':
        case 'D':
          a.setDebug(!a.debug.visible);
          break;
        case 'a':
        case 'A':
          this.toggleDrawer();
          break;
        case 'm':
        case 'M':
          a.audio.setMuted(!a.audio.muted);
          break;
        case 'l':
        case 'L':
          a.loop = !a.loop;
          break;
        case '[':
        case ']': {
          const i = SPEEDS.indexOf(a.speed);
          const j = Math.max(0, Math.min(SPEEDS.length - 1, i + (e.key === ']' ? 1 : -1)));
          a.setSpeed(SPEEDS[j]);
          break;
        }
        default:
          return;
      }
      this.wake();
      this.sync();
    });
  }

  private bindIdle() {
    const wake = () => this.wake();
    window.addEventListener('pointermove', wake);
    window.addEventListener('pointerdown', wake);
    this.wake();
  }

  private wake() {
    document.body.classList.remove('idle');
    clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => {
      if (this.app.playing && !this.drawer.classList.contains('open')) document.body.classList.add('idle');
    }, 2600);
  }

  // ------------------------------------------------------------- drawer
  private toggleDrawer(force?: boolean) {
    const open = force ?? !this.drawer.classList.contains('open');
    this.drawer.classList.toggle('open', open);
    document.body.classList.toggle('drawer-open', open);
    if (open) this.renderDrawer();
  }

  private renderDrawer() {
    for (const b of this.drawer.querySelectorAll<HTMLButtonElement>('.tab')) b.classList.toggle('on', b.dataset.tab === this.tab);
    const body = this.drawerBody;
    body.innerHTML = '';
    if (this.tab === 'fingering') this.renderFingering(body);
    else if (this.tab === 'light') this.renderLight(body);
    else if (this.tab === 'camera') this.renderCamera(body);
    else if (this.tab === 'sound') this.renderSound(body);
    else this.renderDebugTab(body);
  }

  private renderFingering(body: HTMLElement) {
    const p = this.app.piece;
    if (!p) return;
    const t = this.app.t;
    const s = p.perf.stats;
    const head = el('div', 'fing-head');
    head.innerHTML = `<div>Fingering is inferred for the whole piece. Change a hand or finger here and the performance is re-planned around it.</div>
      <div class="stats">${p.perf.notes.length} notes · ${p.overrides.size} override${p.overrides.size === 1 ? '' : 's'} · ${s.approximated} approximated · planned in ${s.planningMs.toFixed(0)} ms</div>`;
    const acts = el('div', 'actions small');
    const clear = el('button', '', 'Reset to defaults');
    clear.title = 'Clear every hand and finger override';
    clear.disabled = !p.overrides.size;
    clear.onclick = () => this.app.clearOverrides();
    const exp = el('button', '', 'Export');
    exp.onclick = () => {
      const blob = new Blob([this.app.exportOverrides()], { type: 'application/json' });
      const a = el('a') as HTMLAnchorElement;
      a.href = URL.createObjectURL(blob);
      a.download = `${p.perf.score.name}-fingering.json`;
      a.click();
    };
    const imp = el('button', '', 'Import');
    imp.onclick = () => {
      const inp = el('input') as HTMLInputElement;
      inp.type = 'file';
      inp.accept = '.json,application/json';
      inp.onchange = async () => {
        const f = inp.files?.[0];
        if (f) this.app.importOverrides(await f.text());
      };
      inp.click();
    };
    acts.append(clear, exp, imp);
    if (p.parsed.tracks.filter((tr) => tr.noteCount > 0).length > 1) {
      const tracks = el('button', '', 'Tracks…');
      tracks.onclick = () => this.trackDialog(p.parsed, p.perf.score.name, p.tracks);
      acts.appendChild(tracks);
    }
    head.appendChild(acts);
    body.appendChild(head);
    const notes = p.perf.notes.filter((n) => n.start > t - 1.2 && n.start < t + 3.5).slice(0, 48);
    const list = el('div', 'fing-list');
    if (!notes.length) list.appendChild(el('div', 'empty', 'No notes near the playhead.'));
    for (const n of notes) list.appendChild(this.noteRow(n, t));
    body.appendChild(list);
  }

  private noteRow(n: PerformanceNote, t: number) {
    const row = el('div', 'note-row');
    if (n.start <= t && t <= n.end) row.classList.add('now');
    const time = el('button', 'ntime', n.start.toFixed(2));
    time.title = 'Go to this note';
    time.onclick = () => this.app.seek(n.start - 0.25);
    const name = el('span', 'nname', noteName(n.midi));
    const hands = el('span', 'seg2');
    for (const h of ['L', 'R'] as Hand[]) {
      const b = el('button', h === n.hand ? 'on' : '', h);
      b.title = h === 'L' ? 'Left hand' : 'Right hand';
      b.onclick = () => this.app.setOverride(n.id, { hand: h, finger: undefined });
      hands.appendChild(b);
    }
    const fingers = el('span', 'seg5');
    for (let f = 1; f <= 5; f++) {
      const b = el('button', f === n.finger ? 'on' : '', String(f));
      b.title = ['', 'Thumb', 'Index', 'Middle', 'Ring', 'Little'][f];
      b.onclick = () => this.app.setOverride(n.id, { finger: f as Finger, hand: n.hand });
      fingers.appendChild(b);
    }
    const flags = el('span', 'nflags');
    const shown = n.flags.filter((f) => f !== 'track-hand');
    flags.textContent = shown.map((f) => FLAG_LABEL[f] ?? f).join(' ');
    flags.title = shown.join(', ');
    if (n.flags.includes('hand-override') || n.flags.includes('finger-override')) row.classList.add('override');
    row.append(time, name, hands, fingers, flags);
    return row;
  }

  private slider(body: HTMLElement, label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt = (v: number) => v.toFixed(2)) {
    const row = el('label', 'slider');
    const lab = el('span', '', label);
    const inp = el('input') as HTMLInputElement;
    inp.type = 'range';
    inp.min = String(min);
    inp.max = String(max);
    inp.step = String(step);
    inp.value = String(get());
    const val = el('span', 'val', fmt(get()));
    inp.oninput = () => {
      set(parseFloat(inp.value));
      val.textContent = fmt(parseFloat(inp.value));
      this.app.settingsChanged();
    };
    row.append(lab, inp, val);
    body.appendChild(row);
    return row;
  }

  /** a section title with an on/off switch; the rows after it dim while it is off */
  private sectionToggle(body: HTMLElement, title: string, get: () => boolean, set: (v: boolean) => void): (rows: HTMLElement[]) => void {
    const head = el('label', 'sec sec-toggle');
    const cb = el('input') as HTMLInputElement;
    cb.type = 'checkbox';
    cb.className = 'switch';
    cb.checked = get();
    cb.setAttribute('aria-label', `${title} on or off`);
    head.append(el('span', '', title), cb);
    body.appendChild(head);
    let rows: HTMLElement[] = [];
    const dim = () => rows.forEach((r) => r.classList.toggle('off', !cb.checked));
    cb.onchange = () => {
      set(cb.checked);
      dim();
      this.app.settingsChanged();
    };
    return (r) => {
      rows = r;
      dim();
    };
  }

  private resetButton(body: HTMLElement, reset: () => void, extra?: HTMLElement) {
    const acts = el('div', 'actions small');
    const b = el('button', '', 'Reset to defaults');
    b.onclick = () => {
      reset();
      this.app.settingsChanged();
      this.renderDrawer();
    };
    acts.append(b);
    if (extra) acts.append(extra);
    body.appendChild(acts);
  }

  private renderSound(body: HTMLElement) {
    const a = this.app;
    const audio = a.audio;
    body.appendChild(el('div', 'sec', 'Room'));
    const room = el('select') as HTMLSelectElement;
    for (const [id, r] of Object.entries(ROOMS)) room.appendChild(new Option(r.label, id, id === audio.room, id === audio.room));
    room.onchange = () => {
      audio.setReverb(audio.reverb, room.value as RoomId);
      a.settingsChanged();
    };
    const row = el('label', 'slider');
    row.append(el('span', '', 'Acoustics'), room);
    body.appendChild(row);
    this.slider(body, 'Reverb', 0, 1, 0.01, () => audio.reverb, (v) => audio.setReverb(v), (v) => `${Math.round(v * 100)}%`);
    body.appendChild(el('div', 'sec', 'Output'));
    this.slider(body, 'Volume', 0, 1, 0.01, () => audio.volume, (v) => audio.setVolume(v), (v) => `${Math.round(v * 100)}%`);
    body.appendChild(
      el('p', 'note', 'The piano is FreePats\' Upright Piano KW, recorded in a living room, so a little of that room is always there. The reverb adds the chosen space on top.'),
    );
    this.resetButton(body, () => a.applySound(DEFAULT_SOUND));
  }

  private renderLight(body: HTMLElement) {
    const a = this.app;
    const look = a.view.look;
    const L = () => a.lights;
    const sl = (label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt?: (v: number) => string) =>
      this.slider(body, label, min, max, step, get, set, fmt);
    body.appendChild(el('div', 'sec', 'Light'));
    sl('Window sun', 0, 1.8, 0.01, () => L().sun, (v) => a.setLights({ sun: v }));
    sl('Sun warmth', 0, 1, 0.01, () => L().warmth, (v) => a.setLights({ warmth: v }));
    sl('Room fill', 0, 2.5, 0.01, () => L().fill, (v) => a.setLights({ fill: v }));
    sl('Cool rim', 0, 2.5, 0.01, () => L().rim, (v) => a.setLights({ rim: v }));
    sl('Joint glow', 0, 2, 0.01, () => look.glow, (v) => (look.glow = v));

    const shafts = this.sectionToggle(body, 'Light shafts', () => L().shaftsOn, (v) => a.setLights({ shaftsOn: v }));
    shafts([sl('Intensity', 0, 2, 0.01, () => L().shafts, (v) => a.setLights({ shafts: v }))]);

    const rake = this.sectionToggle(body, 'Raking light', () => L().rakeOn, (v) => a.setLights({ rakeOn: v }));
    rake([
      sl('Intensity', 0, 2, 0.01, () => L().rake, (v) => a.setLights({ rake: v })),
      sl('Angle', 2, 35, 0.5, () => L().rakeAngle, (v) => a.setLights({ rakeAngle: v }), (v) => `${v.toFixed(1)}°`),
      sl('Direction', -80, 80, 1, () => L().rakeDir, (v) => a.setLights({ rakeDir: v }), (v) => `${v.toFixed(0)}°`),
    ]);

    body.appendChild(el('div', 'sec', 'Grade'));
    sl('Exposure', 0.4, 1.8, 0.01, () => look.exposure, (v) => (look.exposure = v));
    sl('Contrast', 0.8, 1.7, 0.01, () => look.contrast, (v) => (look.contrast = v));
    sl('Saturation', 0, 1.4, 0.01, () => look.saturation, (v) => (look.saturation = v));
    sl('Warmth', -1, 1, 0.01, () => look.warmth, (v) => (look.warmth = v));
    sl('Highlight roll-off', 0, 2, 0.01, () => look.rolloff, (v) => (look.rolloff = v));

    this.resetButton(body, () => {
      a.setLights({ ...DEFAULT_LIGHTS });
      for (const k of ['exposure', 'glow', 'contrast', 'saturation', 'warmth', 'rolloff'] as const) look[k] = DEFAULT_LOOK[k];
    });
  }

  private renderCamera(body: HTMLElement) {
    const a = this.app;
    const look = a.view.look;
    const f = () => a.framing;
    const sl = (label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt?: (v: number) => string) =>
      this.slider(body, label, min, max, step, get, set, fmt);

    const drama = this.sectionToggle(body, 'Camera drama', () => f().dramaOn, (v) => (a.framing.dramaOn = v));
    drama([sl('Amount', 0, 1, 0.01, () => f().drama, (v) => (a.framing.drama = v), (v) => `${Math.round(v * 100)}%`)]);
    body.appendChild(el('p', 'note', 'Slow push-ins at the peaks of a phrase, focus racked to whichever hand leads, and longer lenses from further back.'));

    body.appendChild(el('div', 'sec', 'Lens'));
    sl('Depth of field', 0, 2, 0.01, () => look.dofScale, (v) => (look.dofScale = v));
    sl('Bloom', 0, 2, 0.01, () => look.bloom, (v) => (look.bloom = v));
    sl('Grain', 0, 2, 0.01, () => look.grain, (v) => (look.grain = v));
    sl('Vignette', 0, 2, 0.01, () => look.vignette, (v) => (look.vignette = v));

    const streaks = this.sectionToggle(body, 'Anamorphic streaks', () => look.streaksOn, (v) => (look.streaksOn = v));
    streaks([sl('Strength', 0, 2, 0.01, () => look.streaks, (v) => (look.streaks = v))]);

    const lb = this.sectionToggle(body, 'Letterbox', () => look.letterboxOn, (v) => (look.letterboxOn = v));
    const ar = el('select') as HTMLSelectElement;
    for (const [v, label] of [
      [2.39, '2.39 : 1 (scope)'],
      [2.0, '2 : 1'],
      [1.85, '1.85 : 1 (flat)'],
    ] as const)
      ar.appendChild(new Option(label, String(v), v === look.letterbox, v === look.letterbox));
    ar.onchange = () => {
      look.letterbox = parseFloat(ar.value);
      a.settingsChanged();
    };
    const arRow = el('label', 'slider');
    arRow.append(el('span', '', 'Aspect'), ar);
    body.appendChild(arRow);
    lb([arRow]);

    body.appendChild(el('div', 'sec', 'Framing'));
    sl('Distance', 0.6, 1.8, 0.01, () => f().distance, (v) => (a.framing.distance = v));
    sl('Height', -0.08, 0.25, 0.005, () => f().height, (v) => (a.framing.height = v));
    sl('Orbit', -0.6, 0.6, 0.01, () => f().angle, (v) => (a.framing.angle = v));
    sl('Lens length', 0.6, 1.6, 0.01, () => f().focalScale, (v) => (a.framing.focalScale = v));

    const q = el('select') as HTMLSelectElement;
    for (const v of ['high', 'medium', 'low']) q.appendChild(new Option(`Quality: ${v}`, v, v === a.view.post.quality, v === a.view.post.quality));
    q.onchange = () => {
      a.autoQuality = false;
      a.view.setQuality(q.value as 'high');
      a.renderNow();
    };
    this.resetButton(
      body,
      () => {
        a.framing = { ...DEFAULT_FRAMING };
        for (const k of ['dof', 'dofScale', 'bloom', 'grain', 'vignette', 'streaksOn', 'streaks', 'letterboxOn', 'letterbox'] as const)
          (look as unknown as Record<string, unknown>)[k] = DEFAULT_LOOK[k];
      },
      q,
    );
  }

  private renderDebugTab(body: HTMLElement) {
    const a = this.app;
    const row = el('label', 'check');
    const cb = el('input') as HTMLInputElement;
    cb.type = 'checkbox';
    cb.checked = a.debug.visible;
    cb.onchange = () => a.setDebug(cb.checked);
    row.append(cb, el('span', '', 'Show kinematics overlay (D)'));
    body.appendChild(row);
    body.appendChild(
      el(
        'div',
        'legend',
        `<div><i style="background:#5bd37a"></i>holding a key</div><div><i style="background:#ff8a3d"></i>striking</div><div><i style="background:#4cc9d6"></i>releasing</div><div><i style="background:#f2c84b"></i>preparing</div><div><i style="background:#8a8a8a"></i>resting</div><div><i style="background:#ff2020"></i>cannot reach its key</div><p>Rings are the actual fingertips; spheres are their targets; flat rings mark contact points on keys; lines trace each wrist's plan one second back and two ahead.</p>`,
      ),
    );
    const p = a.piece;
    if (p) {
      const w = el('div', 'stats');
      w.innerHTML = p.perf.warnings.length ? p.perf.warnings.map(escapeHtml).join('<br>') : 'No approximations: every note is within the hands’ reach.';
      body.appendChild(w);
    }
    this.resetButton(body, () => a.setDebug(false));
  }

  private renderDebugInfo() {
    const a = this.app;
    const f = a.frame;
    const p = a.piece;
    if (!f || !p) return;
    const lines: string[] = [];
    lines.push(`t ${a.t.toFixed(3)} s   ${a.fps.toFixed(0)} fps   pedal ${(f.pedal * 100).toFixed(0)}%`);
    for (const h of ['L', 'R'] as Hand[]) {
      const hp = f.hands[h];
      lines.push(`${h} wrist ${hp.wrist.map((v) => (v * 1000).toFixed(0)).join(', ')} mm`);
      const fingers = [1, 2, 3, 4, 5].map((k) => {
        const st = hp.states[k];
        const n = st.note ?? st.next;
        const e = Math.hypot(st.tip[0] - st.target[0], st.tip[1] - st.target[1], st.tip[2] - st.target[2]) * 1000;
        return `  ${k} ${st.phase.padEnd(7)} ${n ? noteName(n.note.midi).padEnd(4) : '    '} ${e > 0.5 ? e.toFixed(1) + 'mm' : ''}`;
      });
      lines.push(...fingers);
    }
    const active = f.sounding.slice(0, 12).map((n) => `${noteName(n.midi)}·${n.hand}${n.finger}`);
    lines.push(`sounding: ${active.join(' ') || '—'}`);
    this.debugInfo.textContent = lines.join('\n');
  }
}

const FLAG_LABEL: Record<string, string> = {
  'hand-override': '✎H',
  'finger-override': '✎F',
  stretch: '↔',
  unreachable: '⚠',
  'finger-conflict': '⇄',
  'early-release': '↑',
  'chord-overflow': '✕',
  scale: 'scale',
  chromatic: 'chrom.',
  arpeggio: 'arp.',
  motif: 'motif',
};

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export { FRAME_STEP };
