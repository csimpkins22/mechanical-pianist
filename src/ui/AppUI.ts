// The interface: a quiet translucent control bar, a title card, and an
// optional drawer for fingering corrections, look and debugging. Plain DOM.
import { FRAME_STEP, SPEEDS, type App } from '../app/App';
import { entryById } from '../app/library';
import { el, escapeHtml, fmt, svg } from './dom';
import { LibrarySheet, NOTE_ICON } from './LibrarySheet';
import { KEYS_ICON, LivePanel } from './LivePanel';
import { exportSize, exportSupport, exportVideo } from '../app/VideoExport';
import { noteName } from '../core/keyboard';
import type { Finger, Hand, PerformanceNote, TrackInfo } from '../core/types';
import type { ParsedMidi } from '../interpretation/MidiEngine';
import { DEFAULT_LOOK } from '../presentation/SceneRenderer';
import { DEFAULT_LIGHTS } from '../presentation/Environment';
import { DEFAULT_FRAMING } from '../presentation/CinematicCamera';
import { ROOMS, type RoomId } from '../audio/AudioEngine';
import { DEFAULT_SOUND } from '../app/settings';
import { STYLES } from '../presentation/VisualStyles';

const ICON = {
  play: '<path d="M8 5.5v13l11-6.5z"/>',
  pause: '<path d="M7 5h3.6v14H7zM13.4 5H17v14h-3.6z"/>',
  restart: '<path d="M6 6h2v12H6zM9.5 12l8.5 6V6z"/>',
  back: '<path d="M11 12l7 5V7zM6 7h2v10H6z" transform="translate(0 0)"/>',
  fwd: '<path d="M13 12L6 7v10zM16 7h2v10h-2z"/>',
  vol: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15 8.5a5 5 0 010 7M17.5 6a8.5 8.5 0 010 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/>',
  mute: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9.5l5 5M20.5 9.5l-5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  gear: '<path d="M12 8.6a3.4 3.4 0 100 6.8 3.4 3.4 0 000-6.8zm8.2 4.6l1.6 1.2-1.7 3-1.9-.7c-.5.4-1.1.8-1.7 1l-.3 2H12l-.3-2a7 7 0 01-1.7-1l-1.9.7-1.7-3 1.6-1.2a7 7 0 010-2l-1.6-1.2 1.7-3 1.9.7c.5-.4 1.1-.8 1.7-1l.3-2h3.4l.3 2c.6.2 1.2.6 1.7 1l1.9-.7 1.7 3-1.6 1.2a7 7 0 010 2z" transform="translate(-1.5 -1) scale(1.02)"/>',
  prev: '<path d="M14.5 6.5L9 12l5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  next: '<path d="M9.5 6.5L15 12l-5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  // an upright piano, its upper panel on, and lifted off with the strings showing
  pianoClosed:
    '<path d="M5.5 13V5.6A1.6 1.6 0 017.1 4h9.8a1.6 1.6 0 011.6 1.6V13M5.5 16.6V20M18.5 16.6V20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.8 13h16.4v3.6H3.8z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M8.5 13v2M12 13v2M15.5 13v2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  pianoOpen:
    '<path d="M5.5 13V8.6M18.5 13V8.6M5.5 16.6V20M18.5 16.6V20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M6.2 2.9l11.2-1.3.5 4.4-11.2 1.3z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8.6 9.2v3.4M10.8 9.2v3.4M13.2 9.2v3.4M15.4 9.2v3.4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" opacity="0.8"/><path d="M3.8 13h16.4v3.6H3.8z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M8.5 13v2M12 13v2M15.5 13v2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
};




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
  private tab: 'fingering' | 'light' | 'camera' | 'sound' | 'export' | 'debug' = 'fingering';
  /** the film export's choices (kept while the page is open) and the export under way */
  private film = { aspect: 16 / 9, longSide: 1920, fps: 30, range: 'all' as 'all' | 'here' };
  private filming: AbortController | null = null;
  private filmState: { f: number; text: string } | null = null;
  private paintFilm: (() => void) | null = null;
  private autoBtn!: HTMLButtonElement;
  private shotLabel!: HTMLSpanElement;
  private openBtn!: HTMLButtonElement;
  private volBtn!: HTMLButtonElement;
  private speedSel!: HTMLSelectElement;
  private library!: LibrarySheet;
  private livePanel!: LivePanel;
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
    // the camera: the director's edit, or one of its shots held (stepped with the arrows)
    const mid = el('div', 'group mid');
    const cams = el('div', 'cams');
    cams.setAttribute('role', 'group');
    cams.setAttribute('aria-label', 'Camera');
    this.autoBtn = el('button', 'seg', 'Cinematic');
    this.autoBtn.title = 'Cinematic (1): the director cuts between shots with the music';
    this.autoBtn.onclick = (e) => {
      e.stopPropagation();
      this.app.setCamera('cinematic');
    };
    const prev = this.btn(ICON.prev, 'Previous shot (,)', () => this.app.stepShot(-1), 'step');
    const next = this.btn(ICON.next, 'Next shot (.)', () => this.app.stepShot(1), 'step');
    this.shotLabel = el('span', 'shot-name');
    const picker = el('div', 'shot');
    picker.append(prev, this.shotLabel, next);
    cams.append(this.autoBtn, picker);
    this.openBtn = el('button', 'pill open-btn');
    this.openBtn.onclick = (e) => {
      e.stopPropagation();
      this.app.setOpen(!this.app.view.look.openPiano);
    };
    mid.append(cams, this.openBtn);
    const right = el('div', 'group right');
    this.speedSel = el('select', 'speed');
    this.speedSel.title = 'Playback speed ([ and ])';
    for (const s of SPEEDS) this.speedSel.appendChild(new Option(`${s}×`, String(s), s === 1, s === 1));
    this.speedSel.onchange = () => this.app.setSpeed(parseFloat(this.speedSel.value));
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
    const lib = el('button', 'pill lib-btn', `${svg(NOTE_ICON, 17)}<span>Library</span>`);
    lib.title = 'Choose a piece, or open your own MIDI file (O)';
    lib.setAttribute('aria-label', 'Library');
    lib.onclick = (e) => {
      e.stopPropagation();
      this.library.toggle();
    };
    const gear = el('button', 'pill set-btn', `${svg(ICON.gear, 17)}<span>Settings</span>`);
    gear.title = 'Settings: fingering, light, camera, sound, export and debug (A)';
    gear.setAttribute('aria-label', 'Settings');
    gear.onclick = (e) => {
      e.stopPropagation();
      this.toggleDrawer();
    };
    const live = el('button', 'live-btn', `${svg(KEYS_ICON, 17)}<span>Play live</span>`);
    live.title = 'Play a MIDI keyboard or the computer keyboard, and the robot plays it (K)';
    live.onclick = (e) => {
      e.stopPropagation();
      this.livePanel.toggle(true);
    };
    right.append(this.speedSel, this.volBtn, vol, lib, live, gear);
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
      ['export', 'Export'],
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
    this.library = new LibrarySheet(this.app, r, { pickFile: () => this.pickFile(), toast: (m, ms) => this.toast(m, ms) });
    this.livePanel = new LivePanel(this.app, r, {
      openSettings: () => {
        this.tab = 'light';
        this.toggleDrawer(true);
      },
      closeOverlays: () => {
        this.library.close();
        this.toggleDrawer(false);
      },
    });

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
      if (p?.perf.warnings.length) this.toast(p.perf.warnings.join(' · '));
      this.lastFingerRefresh = -1;
    }
    if (what === 'loading') this.renderTitle();
    if (what === 'live') this.livePanel?.sync();
    // the Camera tab says what the camera is doing
    if (what === 'view' && this.drawer.classList.contains('open') && this.tab === 'camera') this.renderDrawer();
    this.library.refresh(what);
    if (what === 'quality') this.toast(`Quality lowered to ${this.app.view.post.quality} to keep playback smooth (change it under ⚙ → Camera)`, 6000);
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
    const auto = a.camView === 'cinematic';
    this.autoBtn.classList.toggle('on', auto);
    this.autoBtn.setAttribute('aria-pressed', String(auto));
    const name = a.shotName();
    if (this.shotLabel.textContent !== name) {
      this.shotLabel.textContent = name;
      this.shotLabel.title = auto ? `Now: ${name} (the director's choice; the arrows hold a shot)` : `Holding: ${name}`;
    }
    this.shotLabel.classList.toggle('held', !auto);
    const open = a.view.look.openPiano;
    if (this.openBtn.dataset.open !== String(open)) {
      this.openBtn.dataset.open = String(open);
      this.openBtn.innerHTML = `${svg(open ? ICON.pianoOpen : ICON.pianoClosed, 17)}<span>${open ? 'Close piano' : 'Open piano'}</span>`;
      this.openBtn.title = `${open ? 'Close the piano: put the upper panel back' : 'Open the piano: take the upper panel off to see the hammers and strings'} (I)`;
      this.openBtn.setAttribute('aria-pressed', String(open));
      this.openBtn.classList.toggle('on', open);
    }
    const vk = a.audio.muted ? 'mute' : 'vol';
    if (this.volBtn.dataset.icon !== vk) {
      this.volBtn.dataset.icon = vk;
      this.volBtn.innerHTML = svg(a.audio.muted ? ICON.mute : ICON.vol);
    }
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
    const year = p.source.kind === 'library' ? entryById(p.source.id)?.year : undefined;
    const ld = this.app.loading;
    const same = ld && ld.source.kind === p.source.kind && ld.source.id === p.source.id;
    const next = ld
      ? `<div class="next"><div class="next-l">${same ? 'Re-planning the performance' : `Next · <em>${escapeHtml(ld.title)}</em>`}</div><div class="next-bar"><i style="width:${(Math.max(0.03, ld.fraction) * 100).toFixed(1)}%"></i></div><div class="next-s">${escapeHtml(ld.label)}</div></div>`
      : '';
    const key = `${p.source.kind}:${p.source.id}|${p.title}|${approx}|${next}`;
    if (this.title.dataset.key === key) return;
    this.title.dataset.key = key;
    this.title.classList.toggle('busy', !!ld);
    this.title.innerHTML = `<div class="eyebrow">${escapeHtml(p.artist)}${year ? ` · ${year}` : ''}</div><button class="name" title="Choose another piece (O)">${escapeHtml(p.title)}<span class="chev" aria-hidden="true">${svg('<path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>', 18)}</span></button>${
      approx ? `<div class="note">${approx} note${approx === 1 ? '' : 's'} approximated (beyond the robot's reach)</div>` : ''
    }${next}`;
    (this.title.querySelector('.name') as HTMLButtonElement).onclick = () => this.library.toggle(true);
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
  }

  private async loadFile(f: File) {
    try {
      const { bytes, parsed } = this.app.readFile(await f.arrayBuffer(), f.name);
      const melodic = parsed.tracks.filter((t) => t.noteCount > 0 && t.instrument !== 'percussion');
      if (!melodic.length) throw new Error('no notes found in this file');
      this.library.close();
      if (melodic.length > 1) this.trackDialog(parsed, (tracks) => this.app.openFile(bytes, parsed, f.name, tracks));
      else this.perform(this.app.openFile(bytes, parsed, f.name), f.name);
    } catch (e) {
      this.toast(`Could not read ${f.name}: ${e instanceof Error ? e.message : e}`, 6000);
    }
  }

  /** interpretation runs in the background (progress shows under the title): only failures need saying */
  private perform(job: Promise<void>, name: string) {
    job.catch((e) => this.toast(`Could not perform ${name}: ${e instanceof Error ? e.message : e}`, 6000));
  }

  private trackDialog(parsed: ParsedMidi, go: (tracks: number[]) => Promise<void>, current?: number[]) {
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
    const perform = el('button', 'primary', 'Perform');
    const update = () => (perform.disabled = !checks.some(([, c]) => c.checked));
    for (const [, c] of checks) c.onchange = update;
    update();
    perform.onclick = () => {
      const tracks = checks.filter(([, c]) => c.checked).map(([t]) => t.index);
      back.remove();
      if (!tracks.length) return;
      this.perform(go(tracks), parsed.name);
    };
    const cancel = el('button', '', 'Cancel');
    cancel.onclick = () => back.remove();
    const actions = el('div', 'actions');
    actions.append(cancel, perform);
    box.append(list, actions);
    back.appendChild(box);
    back.onclick = (e) => {
      // (a handler returning false would cancel clicks inside, checkboxes included)
      if (e.target === back) back.remove();
    };
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
      // playing live, the keyboard is a piano, even with a slider or switch in focus
      // (Esc closes the drawer first, then leaves)
      if (this.livePanel.active && !(e.target as HTMLElement).closest('select, textarea, input[type="text"]')) {
        if (e.key === 'Escape' && this.drawer.classList.contains('open')) this.toggleDrawer(false);
        else if (this.livePanel.onKey(e)) e.preventDefault();
        return;
      }
      if ((e.target as HTMLElement).closest('input, select, textarea')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const a = this.app;
      if (e.code === 'KeyK' && !this.library.isOpen && !document.querySelector('.modal-back')) {
        this.livePanel.toggle(true);
        return;
      }
      if (e.key === 'Escape') {
        if (document.querySelector('.modal-back')) document.querySelector('.modal-back')!.remove();
        else if (this.library.isOpen) this.library.close();
        else if (this.drawer.classList.contains('open')) this.toggleDrawer(false);
        return;
      }
      if (e.key === 'o' || e.key === 'O') {
        this.library.toggle();
        return;
      }
      if (this.library.isOpen) return; // the library takes the keyboard while it is open
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
          a.setCamera('cinematic');
          break;
        case '2':
          a.setCamera('follow');
          break;
        case '3':
          a.setCamera('overhead');
          break;
        case '4':
          a.setCamera('macro');
          break;
        case ',':
        case '<':
          a.stepShot(-1);
          break;
        case '.':
        case '>':
          a.stepShot(1);
          break;
        case 'i':
        case 'I':
          a.setOpen(!a.view.look.openPiano);
          this.toast(a.view.look.openPiano ? 'The piano is open' : 'The piano is closed', 1600);
          if (this.drawer.classList.contains('open') && this.tab === 'camera') this.renderDrawer();
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
        case 's':
        case 'S': {
          const i = STYLES.findIndex((s) => s.id === a.view.look.style);
          const st = a.setStyle(STYLES[(i + (e.shiftKey ? STYLES.length - 1 : 1)) % STYLES.length].id);
          this.toast(`Style: ${st.name}`, 1600);
          if (this.drawer.classList.contains('open') && this.tab === 'light') this.renderDrawer();
          break;
        }
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
      if (this.app.playing && !this.drawer.classList.contains('open') && !this.app.live) document.body.classList.add('idle');
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
    else if (this.tab === 'export') this.renderExport(body);
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
      tracks.onclick = () => this.trackDialog(p.parsed, (sel) => this.app.selectTracks(sel), p.tracks);
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
    this.slider(body, 'Picture sync', -150, 150, 5, () => a.syncMs, (v) => (a.syncMs = v), (v) => (v === 0 ? '0' : `${v > 0 ? '+' : ''}${v.toFixed(0)} ms`));
    body.appendChild(el('p', 'note', 'If the hands look late against the sound (common with Bluetooth headphones), move Picture sync right; if early, left.'));
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
    body.appendChild(el('div', 'sec', 'Style'));
    const chips = el('div', 'chips');
    for (const st of STYLES) {
      const b = el('button', 'chip', st.name);
      b.title = st.blurb;
      b.classList.toggle('on', look.style === st.id);
      b.onclick = () => {
        a.setStyle(st.id);
        this.renderDrawer();
      };
      chips.appendChild(b);
    }
    body.appendChild(chips);
    const cur = STYLES.find((s) => s.id === look.style);
    if (cur) body.appendChild(el('p', 'note', `${cur.blurb} Press S to step through the styles; every slider below still applies.`));

    body.appendChild(el('div', 'sec', 'Light'));
    sl('Window sun', 0, 1.8, 0.01, () => L().sun, (v) => a.setLights({ sun: v }));
    sl('Sun warmth', -1, 1, 0.01, () => L().warmth, (v) => a.setLights({ warmth: v }), (v) => (v < 0 ? `cool ${(-v).toFixed(2)}` : v.toFixed(2)));
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

    const bounce = this.sectionToggle(body, 'Bounced light', () => L().bounceOn, (v) => a.setLights({ bounceOn: v }));
    bounce([sl('Amount', 0, 1.5, 0.01, () => L().bounce, (v) => a.setLights({ bounce: v }))]);
    const ao = this.sectionToggle(body, 'Contact shadows (AO)', () => look.aoOn, (v) => (look.aoOn = v));
    ao([sl('Strength', 0, 1, 0.01, () => look.ao, (v) => (look.ao = v))]);
    this.sectionToggle(body, 'Reflections in the lacquer', () => look.reflectionsOn, (v) => (look.reflectionsOn = v))([]);
    if (a.view.post.quality === 'low') body.appendChild(el('p', 'note', 'Contact shadows and lacquer reflections need medium or high quality.'));

    body.appendChild(el('div', 'sec', 'Grade'));
    sl('Exposure', 0.4, 1.8, 0.01, () => look.exposure, (v) => (look.exposure = v));
    sl('Contrast', 0.8, 1.7, 0.01, () => look.contrast, (v) => (look.contrast = v));
    sl('Saturation', 0, 1.4, 0.01, () => look.saturation, (v) => (look.saturation = v));
    sl('Warmth', -1, 1, 0.01, () => look.warmth, (v) => (look.warmth = v));
    sl('Highlight roll-off', 0, 2, 0.01, () => look.rolloff, (v) => (look.rolloff = v));
    sl('Faded blacks', 0, 1, 0.01, () => look.fade, (v) => (look.fade = v));
    sl('Keep cyan', 0, 1, 0.01, () => look.accent, (v) => (look.accent = v));

    this.resetButton(body, () => {
      a.setStyle('golden');
      for (const k of ['aoOn', 'ao', 'reflectionsOn'] as const) (look as unknown as Record<string, unknown>)[k] = DEFAULT_LOOK[k];
    });
  }

  /** a finished film of the performance: shape, size, frame rate, range; rendered offline, offered as an MP4 */
  private renderExport(body: HTMLElement) {
    const a = this.app;
    const p = a.piece;
    if (!p) return;
    const film = this.film;
    body.appendChild(
      el(
        'p',
        'note',
        'Renders the performance as a film: every frame at full quality, drawn at its exact time (a slower computer only takes longer), with the piano, into an MP4. It uses the current camera, style and look; the controls, title and this panel never appear in it.',
      ),
    );
    body.appendChild(el('div', 'sec', 'Shape'));
    const chips = el('div', 'chips');
    for (const [v, label] of [
      [16 / 9, '16:9'],
      [2.39, '2.39:1 scope'],
      [1.85, '1.85:1'],
      [4 / 3, '4:3'],
      [1, '1:1'],
      [4 / 5, '4:5'],
      [9 / 16, '9:16 vertical'],
    ] as [number, string][]) {
      const b = el('button', 'chip', label);
      b.classList.toggle('on', Math.abs(film.aspect - v) < 1e-3);
      b.onclick = () => {
        film.aspect = v;
        this.renderDrawer();
      };
      chips.appendChild(b);
    }
    body.appendChild(chips);
    const row = (label: string, ctl: HTMLElement) => {
      const r = el('label', 'slider');
      r.append(el('span', '', label), ctl);
      body.appendChild(r);
      return r;
    };
    const select = (opts: [string, string][], value: string, set: (v: string) => void) => {
      const s = el('select') as HTMLSelectElement;
      for (const [v, l] of opts) s.appendChild(new Option(l, v, v === value, v === value));
      s.onchange = () => {
        set(s.value);
        this.renderDrawer();
      };
      return s;
    };
    body.appendChild(el('div', 'sec', 'Film'));
    row('Size', select([['1920', '1080p (HD)'], ['2560', '1440p'], ['3840', '4K (UHD)']], String(film.longSide), (v) => (film.longSide = +v)));
    row('Frame rate', select([['24', '24 fps (film)'], ['30', '30 fps'], ['60', '60 fps']], String(film.fps), (v) => (film.fps = +v)));
    row(
      'Range',
      select(
        [
          ['all', 'The whole piece'],
          ['here', `From the playhead (${fmt(a.t, false)})`],
        ],
        film.range,
        (v) => (film.range = v as 'all' | 'here'),
      ),
    );
    const { width, height } = exportSize(film.aspect, film.longSide);
    const t0 = film.range === 'here' ? a.t : 0;
    const t1 = a.duration;
    const mb = ((width * height * film.fps * 0.35 + 320000) * (t1 - t0)) / 8 / 1e6;
    body.appendChild(el('p', 'note', `${width} × ${height}, ${fmt(t1 - t0, false)} long, about ${mb < 1000 ? `${Math.round(mb)} MB` : `${(mb / 1000).toFixed(1)} GB`}.`));

    const status = el('div', 'export-status');
    const bar = el('div', 'export-bar', '<i></i>');
    const label = el('div', 'export-label');
    status.append(bar, label);
    const acts = el('div', 'actions');
    const go = el('button', 'primary', this.filming ? 'Exporting…' : 'Export MP4');
    go.disabled = !!this.filming;
    const cancel = el('button', '', 'Cancel');
    cancel.hidden = !this.filming;
    cancel.onclick = () => this.filming?.abort();
    acts.append(cancel, go);
    body.append(acts, status);
    // the export outlives this panel (switching tabs redraws it): its state is kept apart
    this.paintFilm = () => {
      const st = this.filmState;
      status.hidden = !st;
      if (!st) return;
      (bar.firstChild as HTMLElement).style.width = `${(Math.max(0.01, Math.min(1, st.f)) * 100).toFixed(1)}%`;
      label.textContent = st.text;
    };
    this.paintFilm();
    const show = (f: number, text: string) => {
      this.filmState = { f, text };
      this.paintFilm?.();
    };
    go.onclick = async () => {
      if (this.filming) return;
      const support = await exportSupport(width, height, film.fps);
      if (!support.video) {
        show(0, `This browser cannot encode ${width} × ${height} H.264 video. Try a smaller size, or Chrome, Edge or Safari.`);
        return;
      }
      const ac = new AbortController();
      this.filming = ac;
      go.disabled = true;
      go.textContent = 'Exporting…';
      cancel.hidden = false;
      const name = `${p.artist} - ${p.title}`.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
      try {
        const res = await exportVideo(
          a,
          { aspect: film.aspect, longSide: film.longSide, fps: film.fps, t0, t1 },
          (pr) => {
            if (pr.stage === 'sound') show(0.01, 'Rendering the piano…');
            else if (pr.stage === 'finishing') show(1, 'Finishing the file…');
            else show(pr.frame / pr.frames, `Frame ${pr.frame} of ${pr.frames}${pr.eta !== null ? ` · about ${fmt(pr.eta, false)} left` : ''}`);
          },
          ac.signal,
        );
        const filename = `${name} (${res.width}x${res.height} ${film.fps}fps).mp4`;
        show(1, `Done: ${(res.blob.size / 1e6).toFixed(0)} MB${res.audio ? '' : ' (no sound: this browser cannot encode audio)'}. Saving…`);
        const saved = await saveFile(filename, res.blob);
        show(1, saved ? `Saved ${filename}` : 'Not saved.');
      } catch (e) {
        show(0, (e as Error)?.name === 'AbortError' ? 'Export cancelled.' : `Export failed: ${e instanceof Error ? e.message : e}`);
      } finally {
        this.filming = null;
        if (this.tab === 'export' && this.drawer.classList.contains('open')) this.renderDrawer();
      }
    };
  }

  private renderCamera(body: HTMLElement) {
    const a = this.app;
    const look = a.view.look;
    const f = () => a.framing;
    const sl = (label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt?: (v: number) => string) =>
      this.slider(body, label, min, max, step, get, set, fmt);

    if (a.piece && a.camView === 'cinematic') {
      const sh = a.piece.camera.director.shotAt(a.t);
      body.appendChild(
        el('p', 'note', `Cinematic cuts between designed camera moves at phrase points. Now: shot ${sh.index + 1} of ${sh.count}, “${escapeHtml(sh.name)}”. The arrows on the bar hold one shot instead (, and .), following the hands gently; Open piano adds the shots inside it.`),
      );
    } else if (a.piece) {
      body.appendChild(el('p', 'note', `Holding “${escapeHtml(a.shotName())}”, following the hands gently. Cinematic on the bar (1) hands the camera back to the director.`));
    }
    const drama = this.sectionToggle(body, 'Camera drama', () => f().dramaOn, (v) => (a.framing.dramaOn = v));
    drama([sl('Amount', 0, 1, 0.01, () => f().drama, (v) => (a.framing.drama = v), (v) => `${Math.round(v * 100)}%`)]);
    body.appendChild(el('p', 'note', 'For the Follow, Overhead and Macro cameras: slow push-ins at the peaks of a phrase, focus racked to whichever hand leads, and longer lenses from further back.'));

    body.appendChild(el('div', 'sec', 'Lens'));
    sl('Depth of field', 0, 2, 0.01, () => look.dofScale, (v) => (look.dofScale = v));
    sl('Bloom', 0, 2, 0.01, () => look.bloom, (v) => (look.bloom = v));
    sl('Grain', 0, 2, 0.01, () => look.grain, (v) => (look.grain = v));
    sl('Vignette', 0, 2, 0.01, () => look.vignette, (v) => (look.vignette = v));

    const blur = this.sectionToggle(body, 'Motion blur', () => look.motionBlurOn, (v) => (look.motionBlurOn = v));
    blur([sl('Shutter', 45, 270, 5, () => look.shutter, (v) => (look.shutter = v), (v) => `${v.toFixed(0)}°`)]);
    if (a.view.post.quality === 'low') body.appendChild(el('p', 'note', 'Motion blur needs medium or high quality.'));

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
        for (const k of ['dof', 'dofScale', 'bloom', 'grain', 'vignette', 'motionBlurOn', 'shutter', 'streaksOn', 'streaks', 'letterboxOn', 'letterbox'] as const)
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
    if (a.camView === 'cinematic') {
      const sh = p.camera.director.shotAt(a.t);
      lines.push(`shot ${sh.index + 1}/${sh.count}  ${sh.name}  ${sh.start.toFixed(1)}–${sh.end.toFixed(1)} s`);
    } else lines.push(`holding  ${a.shotName()}${typeof a.camView === 'object' ? `  (${a.camView.hand})` : ''}`);
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


export { FRAME_STEP };

/**
 * Offer a finished file: through the page's downloads capability where it
 * runs as a published artifact (the viewer confirms the save), else as an
 * ordinary browser download.
 */
async function saveFile(filename: string, blob: Blob): Promise<boolean> {
  const claude = (window as unknown as { claude?: { use(name: string): Promise<unknown> } }).claude;
  const downloads = claude ? ((await claude.use('downloads')) as { save(r: { filename: string; data: Blob }): Promise<unknown> } | null) : null;
  if (downloads) {
    try {
      await downloads.save({ filename, data: blob });
      return true;
    } catch {
      return false;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  return true;
}
