// The library, laid out like a concert programme: the pieces that come with
// the app (originals, classical, songs), then the viewer's own MIDI files,
// which are kept in this browser. Opening it starts preparing the library
// pieces in the background, so that each opens at once afterwards.
import type { App, PieceSource, UserFile } from '../app/App';
import { LIBRARY, type LibraryEntry, type LibraryGroup } from '../app/library';
import { el, escapeHtml, fmt, svg } from './dom';

export const NOTE_ICON =
  '<path d="M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM20 15.4a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z"/><path d="M7.5 6.3 20 3.6v11.8h-1.5V7.6L9 9.7V18H7.5z"/>';
const PLUS_ICON = '<path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>';

const GROUPS: { id: LibraryGroup; label: string }[] = [
  { id: 'Songs', label: 'Songs' },
  { id: 'Classical', label: 'Classical' },
  { id: 'Original', label: 'Original works' },
];

export class LibrarySheet {
  private back = el('div', 'library');
  private panel = el('div', 'lib-panel');
  private body = el('div', 'lib-body');
  private statusCells = new Map<string, HTMLElement>();
  private files: UserFile[] = [];
  private prepared = false;
  private statusQueued = false;
  private returnFocus: HTMLElement | null = null;

  constructor(
    private app: App,
    root: HTMLElement,
    private actions: { pickFile(): void; toast(msg: string, ms?: number): void },
  ) {
    this.back.setAttribute('role', 'dialog');
    this.back.setAttribute('aria-modal', 'true');
    this.back.setAttribute('aria-label', 'Library');
    const head = el('header', 'lib-head');
    head.innerHTML = `<div><div class="eyebrow">The Mechanical Pianist</div><h2>Programme</h2></div>`;
    const open = el('button', 'lib-open', `${svg(PLUS_ICON, 16)}<span>Open a MIDI file</span>`);
    open.title = 'Perform a MIDI file from your computer (or drop one anywhere)';
    open.onclick = () => this.actions.pickFile();
    const close = el('button', 'close', '×');
    close.title = 'Close (Esc)';
    close.setAttribute('aria-label', 'Close the library');
    close.onclick = () => this.close();
    head.append(open, close);
    const foot = el(
      'footer',
      'lib-foot',
      'Each piece is interpreted once (hands, fingering, motion), then kept in this browser. <span><kbd>O</kbd> library · <kbd>Esc</kbd> close</span>',
    );
    this.panel.append(head, this.body, foot);
    this.back.appendChild(this.panel);
    this.back.onclick = (e) => {
      // (a handler returning false would cancel clicks inside, checkboxes included)
      if (e.target === this.back) this.close();
    };
    root.appendChild(this.back);
    this.app.planner.onStatus = () => this.queueStatus();
  }

  get isOpen() {
    return this.back.classList.contains('open');
  }

  toggle(force?: boolean) {
    if (force ?? !this.isOpen) this.open();
    else this.close();
  }

  open() {
    if (this.isOpen) return;
    this.returnFocus = document.activeElement as HTMLElement | null;
    document.body.classList.add('library-open');
    this.back.classList.add('open');
    void this.render().then(() => {
      const cur = this.body.querySelector<HTMLElement>('.lib-row.current') ?? this.body.querySelector<HTMLElement>('.lib-row');
      cur?.focus({ preventScroll: false });
    });
    if (!this.prepared) {
      this.prepared = true;
      this.app.prepareLibrary();
    }
  }

  close() {
    if (!this.isOpen) return;
    this.back.classList.remove('open');
    document.body.classList.remove('library-open');
    this.returnFocus?.focus?.();
  }

  /** the app changed (a piece, its loading, the viewer's files) */
  refresh(what: string) {
    if (what === 'files') {
      void this.loadFiles().then(() => {
        if (this.isOpen) void this.render();
      });
    }
    else if (this.isOpen && (what === 'piece' || what === 'loading')) this.queueStatus();
  }

  private async loadFiles() {
    this.files = await this.app.userFiles();
  }

  private async render() {
    await this.loadFiles();
    this.body.innerHTML = '';
    this.statusCells.clear();
    let n = 0;
    for (const g of GROUPS) {
      const sec = el('section', 'lib-sec');
      sec.appendChild(el('h3', 'sec', g.label));
      for (const e of LIBRARY.filter((x) => x.group === g.id)) sec.appendChild(this.entryRow(e, ++n));
      this.body.appendChild(sec);
    }
    const mine = el('section', 'lib-sec');
    mine.appendChild(el('h3', 'sec', 'Your files'));
    if (!this.files.length) {
      const empty = el('button', 'lib-empty');
      empty.innerHTML = `${svg(PLUS_ICON, 18)}<span><b>Open a MIDI file</b> or drop one anywhere on the page. It is performed at once and kept here, in this browser.</span>`;
      empty.onclick = () => this.actions.pickFile();
      mine.appendChild(empty);
    }
    for (const f of this.files) mine.appendChild(this.fileRow(f));
    this.body.appendChild(mine);
    await this.updateStatus();
  }

  private entryRow(e: LibraryEntry, n: number) {
    const info = this.app.entryInfo(e);
    const row = el('button', 'lib-row');
    row.dataset.key = `library:${e.id}`;
    row.innerHTML = `<span class="no">${String(n).padStart(2, '0')}</span>
      <span class="what"><span class="t">${escapeHtml(e.title)}</span><span class="a">${escapeHtml(e.artist)}${e.year ? ` · ${e.year}` : ''}</span><span class="b">${escapeHtml(e.blurb)}</span></span>
      <span class="len">${fmt(info.duration, false)}</span>`;
    const st = el('span', 'st');
    row.appendChild(st);
    this.statusCells.set(`library:${e.id}`, st);
    row.onclick = () => {
      this.close();
      if (this.isCurrent(`library:${e.id}`)) return;
      this.app.openEntry(e).catch((err) => this.actions.toast(`Could not perform ${e.title}: ${err instanceof Error ? err.message : err}`, 6000));
    };
    return row;
  }

  private fileRow(f: UserFile) {
    const wrap = el('div', 'lib-file');
    const row = el('button', 'lib-row');
    row.dataset.key = `file:${f.id}`;
    const added = new Date(f.added).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    row.innerHTML = `<span class="no">${svg(NOTE_ICON, 14)}</span>
      <span class="what"><span class="t">${escapeHtml(f.title)}</span><span class="a">${escapeHtml(f.name)} · added ${escapeHtml(added)}</span></span>
      <span class="len"></span>`;
    const st = el('span', 'st');
    row.appendChild(st);
    this.statusCells.set(`file:${f.id}`, st);
    row.onclick = () => {
      this.close();
      if (this.isCurrent(`file:${f.id}`)) return;
      this.app.openUserFile(f).catch((err) => this.actions.toast(`Could not perform ${f.title}: ${err instanceof Error ? err.message : err}`, 6000));
    };
    const rm = el('button', 'lib-remove', '×');
    rm.title = `Remove ${f.name} from this browser`;
    rm.setAttribute('aria-label', rm.title);
    rm.onclick = () => void this.app.forgetFile(f.id);
    wrap.append(row, rm);
    return wrap;
  }

  private isCurrent(key: string) {
    const s = this.app.piece?.source;
    return !!s && sourceKey(s) === key;
  }

  private queueStatus() {
    if (this.statusQueued || !this.isOpen) return;
    this.statusQueued = true;
    requestAnimationFrame(() => {
      this.statusQueued = false;
      void this.updateStatus();
    });
  }

  /** now playing / opening / preparing n% / ready */
  private async updateStatus() {
    const loading = this.app.loading;
    for (const [key, cell] of this.statusCells) {
      const row = cell.parentElement!;
      const current = this.isCurrent(key);
      row.classList.toggle('current', current);
      let html = '';
      if (current) html = `<span class="eq${this.app.playing ? ' on' : ''}"><i></i><i></i><i></i></span>Now playing`;
      else if (key.startsWith('library:')) {
        const e = LIBRARY.find((x) => `library:${x.id}` === key)!;
        const opening = loading && sourceKey(loading.source) === key;
        const f = opening ? loading.fraction : await this.app.entryStatus(e);
        if (opening) html = `${ring(f ?? 0)}Opening`;
        else if (f === 1) html = '<span class="ready">Ready</span>';
        else if (f !== null) html = `${ring(f)}Preparing ${Math.round(f * 100)}%`;
      } else if (loading && sourceKey(loading.source) === key) {
        html = `${ring(loading.fraction)}Opening`;
      }
      if (cell.innerHTML !== html) cell.innerHTML = html;
    }
  }
}

const sourceKey = (s: PieceSource) => `${s.kind}:${s.id}`;

/** a small progress ring */
function ring(f: number) {
  return `<span class="ring" style="--p:${Math.max(0.04, Math.min(1, f)).toFixed(3)}"></span>`;
}
