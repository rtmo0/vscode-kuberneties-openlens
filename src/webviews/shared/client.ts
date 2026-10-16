/* Shared client-side helpers bundled into every webview. */
import { formatAge } from '../../core/format';
import type { ActionId, Cell, Column, ObjectRef, Row, TableData, Tone } from '../../core/protocol';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode = acquireVsCodeApi();

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

const pending = new Map<string, PendingRequest>();
const listeners = new Map<string, Set<(payload: unknown) => void>>();

queueMicrotask(() => void request('ready').catch(() => undefined));

let requestCounter = 0;

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as {
    type: string;
    requestId?: string;
    payload?: unknown;
    error?: { message: string; code?: number };
  };

  if (message.type === 'response' && message.requestId) {
    const entry = pending.get(message.requestId);
    if (entry) {
      pending.delete(message.requestId);
      if (message.error) {
        entry.reject(new Error(message.error.message));
      } else {
        entry.resolve(message.payload);
      }
    }
    return;
  }

  const handlers = listeners.get(message.type);
  if (handlers) {
    for (const handler of handlers) {
      handler(message.payload);
    }
  }
});

/** Send a request to the extension host and await the correlated response. */
export function request<T = unknown>(type: string, payload?: unknown): Promise<T> {
  const requestId = `req-${Date.now()}-${requestCounter++}`;
  return new Promise<T>((resolve, reject) => {
    pending.set(requestId, {
      resolve: resolve as (value: unknown) => void,
      reject
    });
    vscode.postMessage({ type, requestId, payload });
  });
}

/** Subscribe to push messages from the extension host. */
export function on<T = unknown>(type: string, handler: (payload: T) => void): void {
  let set = listeners.get(type);
  if (!set) {
    set = new Set();
    listeners.set(type, set);
  }
  set.add(handler as (payload: unknown) => void);
}

export function getState<T>(fallback: T): T {
  return { ...fallback, ...((vscode.getState() as Partial<T>) ?? {}) };
}

export function setState<T>(state: T): void {
  vscode.setState(state);
}

/** Red frame and banner when the panel shows a protected (production) context. */
export function initMeta(): void {
  let banner = document.querySelector<HTMLElement>('.protected-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'protected-banner';
    document.body.prepend(banner);
  }
  const apply = (meta: { context?: string; protected: boolean }): void => {
    document.body.classList.toggle('protected', meta.protected);
    banner!.textContent = `⚠ Protected context ${meta.context ?? ''} — changes need the context name typed to confirm`;
  };
  on('meta', apply);
  request<{ context?: string; protected: boolean }>('meta').then(apply, () => undefined);
}

// ───────────────────────────── DOM helpers ─────────────────────────────

type Props<K extends keyof HTMLElementTagNameMap> = Partial<Omit<HTMLElementTagNameMap[K], 'style' | 'dataset'>> & {
  className?: string;
  text?: string;
  title?: string;
  dataset?: Record<string, string>;
};

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props<K> = {}, ...children: Array<Node | string | null | undefined | false>): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { className, text, dataset, ...rest } = props;
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  if (dataset) {
    Object.assign(node.dataset, dataset);
  }
  Object.assign(node, rest);
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false) {
      node.append(child);
    }
  }
  return node;
}

export function clear(node: Element): void {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

export function $(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ───────────────────────────── icons ─────────────────────────────

const ICONS: Record<string, string> = {
  details: 'M2 3h12v1.5H2zM2 7.25h12v1.5H2zM2 11.5h8V13H2z',
  yaml: 'M11.7 1.3l3 3-8.9 8.9H2.8v-3zM4.3 10.8v.9h.9l7.4-7.4-.9-.9z',
  delete: 'M6 1h4v1.5h4V4H2V2.5h4zM3.5 5h9l-.7 10H4.2zM6 6.5v7h1.2v-7zm2.8 0v7H10v-7z',
  logs: 'M2 2h12v12H2zm1.5 1.5v9h9v-9zM5 5h6v1.2H5zm0 2.4h6v1.2H5zm0 2.4h4V11H5z',
  shell: 'M1.5 2h13v12h-13zM3 3.5v9h10v-9zm1 1.3l3 2.7-3 2.7-.8-.9 2-1.8-2-1.8zM7.8 10h3.7v1.2H7.8z',
  forward: 'M9 2l5 5-5 5V9C5 9 3 10.5 2 13c.4-4 2.5-7.2 7-7.5z',
  scale: 'M2 2h5v1.5H4.6L7.5 6.4 6.4 7.5 3.5 4.6V7H2zm12 12H9v-1.5h2.4L8.5 9.6l1.1-1.1 2.9 2.9V9H14z',
  restart: 'M8 2a6 6 0 105.7 7.9l-1.4-.5A4.5 4.5 0 118 3.5c1.3 0 2.4.5 3.2 1.4L9 7h5V2l-1.8 1.8A6 6 0 008 2z',
  trigger: 'M4 2l10 6-10 6z',
  suspend: 'M4 2h3v12H4zm5 0h3v12H9z',
  resume: 'M4 2l10 6-10 6z',
  cordon: 'M8 1a7 7 0 110 14A7 7 0 018 1zm0 1.5a5.5 5.5 0 00-4.3 8.9l7.7-7.7A5.5 5.5 0 008 2.5zm4.3 2.1l-7.7 7.7a5.5 5.5 0 007.7-7.7z',
  uncordon: 'M6.5 11.3L3 7.8l1.1-1.1 2.4 2.4 5.4-5.4L13 4.8z',
  helmUninstall: 'M6 1h4v1.5h4V4H2V2.5h4zM3.5 5h9l-.7 10H4.2z',
  drain: 'M8 1l5 5h-3.2v4H6.2V6H3zM2 12h12v2.5H2z',
  nodeShell: 'M1 2h14v12H1zm1.5 1.5v9h11v-9zM3.8 5.2l2.7 2.3-2.7 2.3-.8-.9 1.7-1.4L3 6.1zM7.5 9.5H12v1.2H7.5z',
  debug: 'M5.5 2.5L7 4h2l1.5-1.5 1 1L10.3 4.7A3.5 3.5 0 0111.5 7H14v1.5h-2.5V10H14v1.5h-2.6A3.6 3.6 0 018 14a3.6 3.6 0 01-3.4-2.5H2V10h2.5V8.5H2V7h2.5c.2-.9.6-1.7 1.2-2.3L4.5 3.5zM6 6.5v4.3c0 1 .9 1.8 2 1.8s2-.8 2-1.8V6.5c0-1-.9-1.5-2-1.5s-2 .5-2 1.5z',
  kubeconfig: 'M5 2a3 3 0 012.8 4H15v2.5h-1.5V11H12V8.5H7.8A3 3 0 115 2zm0 1.5a1.5 1.5 0 100 3 1.5 1.5 0 000-3z',
  star: 'M8 1l2.1 4.4 4.9.6-3.6 3.4.9 4.8L8 11.9l-4.3 2.3.9-4.8L1 6l4.9-.6z',
  starOff: 'M8 1l2.1 4.4 4.9.6-3.6 3.4.9 4.8L8 11.9l-4.3 2.3.9-4.8L1 6l4.9-.6zm0 3.3L6.9 6.7l-2.6.3 1.9 1.8-.5 2.6L8 10.1l2.3 1.3-.5-2.6 1.9-1.8-2.6-.3z',
  download: 'M7.3 1h1.4v8.2l2.9-2.9 1 1L8 11.9 3.4 7.3l1-1 2.9 2.9zM2 13.5h12V15H2z',
  upload: 'M8 1l4.6 4.6-1 1-2.9-2.9V12H7.3V3.7L4.4 6.6l-1-1zM2 13.5h12V15H2z',
  graph: 'M2 2h4v3H2zm8 0h4v3h-4zM6 11h4v3H6zM4 5h1v2.5h6V5h1v3.5H8.5V11h-1V8.5H4z',
  pause: 'M4 2h3v12H4zm5 0h3v12H9z',
  play: 'M4 2l10 6-10 6z',
  diff: 'M4 1h1.5v3H8.5v1.5H5.5v3H4v-3H1V4h3zM8 11h7v1.5H8zM10 1l5 5-5 5V7.5H8V4.5h2z',
  more: 'M3 6.5a1.5 1.5 0 110 3 1.5 1.5 0 010-3zm5 0a1.5 1.5 0 110 3 1.5 1.5 0 010-3zm5 0a1.5 1.5 0 110 3 1.5 1.5 0 010-3z',
  refresh: 'M8 2a6 6 0 105.7 7.9l-1.4-.5A4.5 4.5 0 118 3.5c1.3 0 2.4.5 3.2 1.4L9 7h5V2l-1.8 1.8A6 6 0 008 2z',
  back: 'M7 3L2 8l5 5 1-1-3.3-3.3H14V7.3H4.7L8 4z',
  copy: 'M5 1h8v10H5zm1.5 1.5v7h5v-7zM2 4h1.5v9.5H10V15H2z',
  eye: 'M8 3c3.5 0 6 3 7 5-1 2-3.5 5-7 5S2 10 1 8c1-2 3.5-5 7-5zm0 1.5C5.6 4.5 3.7 6.4 2.7 8c1 1.6 2.9 3.5 5.3 3.5s4.3-1.9 5.3-3.5c-1-1.6-2.9-3.5-5.3-3.5zM8 6a2 2 0 110 4 2 2 0 010-4z',
  eyeOff: 'M2.1 1l12.9 12.9-1.1 1.1-2.4-2.4c-1 .5-2.2.9-3.5.9-3.5 0-6-3-7-5 .6-1.2 1.6-2.6 3-3.6L1 2.1zM8 3c3.5 0 6 3 7 5-.4.9-1.1 1.9-2 2.8l-1.1-1.1c.6-.5 1-1.1 1.4-1.7-1-1.6-2.9-3.5-5.3-3.5-.6 0-1.1.1-1.6.3L5.2 3.6C6 3.2 7 3 8 3z',
  add: 'M7.3 2h1.4v5.3H14v1.4H8.7V14H7.3V8.7H2V7.3h5.3z',
  edit: 'M11.7 1.3l3 3-8.9 8.9H2.8v-3zM4.3 10.8v.9h.9l7.4-7.4-.9-.9z',
  search: 'M6.5 1a5.5 5.5 0 014.4 8.8l3.9 3.9-1.1 1.1-3.9-3.9A5.5 5.5 0 116.5 1zm0 1.5a4 4 0 100 8 4 4 0 000-8z',
  history: 'M8 2a6 6 0 11-6 6h1.5A4.5 4.5 0 108 3.5c-1.4 0-2.6.6-3.4 1.6L6.5 7H2V2.5l1.5 1.5A6 6 0 018 2zm-.7 2.5h1.4v3.2l2.3 2.3-1 1-2.7-2.7z'
};

export function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name] ?? ICONS.details);
  path.setAttribute('fill-rule', 'evenodd');
  svg.append(path);
  return svg;
}

export const ACTION_TITLES: Record<ActionId, string> = {
  details: 'Details',
  yaml: 'Edit YAML',
  delete: 'Delete',
  logs: 'Logs',
  shell: 'Shell',
  forward: 'Port Forward',
  scale: 'Scale',
  restart: 'Restart',
  trigger: 'Trigger Now',
  suspend: 'Suspend',
  resume: 'Resume',
  cordon: 'Cordon',
  uncordon: 'Uncordon',
  drain: 'Drain',
  nodeShell: 'Node Shell',
  debug: 'Debug Container',
  kubeconfig: 'Kubeconfig for This Account',
  helmUninstall: 'Uninstall'
};

export function iconButton(name: string, title: string, onClick: (event: MouseEvent) => void, className = ''): HTMLButtonElement {
  const button = el('button', { className: `icon-btn ${className}`.trim(), title, type: 'button' }, icon(name));
  button.setAttribute('aria-label', title);
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick(event);
  });
  return button;
}

export function actionButton(action: ActionId, onClick: () => void, withLabel = false): HTMLButtonElement {
  const title = ACTION_TITLES[action];
  if (!withLabel) {
    return iconButton(action, title, onClick, action === 'delete' || action === 'helmUninstall' ? 'danger' : '');
  }
  const button = el('button', { className: `btn ${action === 'delete' || action === 'helmUninstall' ? 'danger' : ''}`, type: 'button' }, icon(action), title);
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

// ───────────────────────────── menus ─────────────────────────────

let openMenuEl: HTMLElement | undefined;

function closeMenu(): void {
  openMenuEl?.remove();
  openMenuEl = undefined;
}

document.addEventListener('click', closeMenu);
document.addEventListener('keydown', (event) => event.key === 'Escape' && closeMenu());
window.addEventListener('blur', closeMenu);

/** A small popup menu under `anchor`. */
export function showMenu(anchor: HTMLElement, items: Array<{ label: string; icon: string; danger?: boolean; run: () => void }>): void {
  closeMenu();
  const menu = el('div', { className: 'menu' });
  for (const item of items) {
    const button = el('button', { className: `menu-item${item.danger ? ' danger' : ''}`, type: 'button' }, icon(item.icon), item.label);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      closeMenu();
      item.run();
    });
    menu.append(button);
  }
  document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  menu.style.left = `${Math.max(4, Math.min(rect.right - width, window.innerWidth - width - 4)) + window.scrollX}px`;
  const below = rect.bottom + height + 4 < window.innerHeight;
  menu.style.top = `${(below ? rect.bottom + 2 : rect.top - height - 2) + window.scrollY}px`;
  openMenuEl = menu;
}

/** Actions shown directly in a row; the rest go to the "⋯" menu. */
const INLINE_ACTIONS = new Set<ActionId>(['logs', 'shell']);

// ───────────────────────────── rendering ─────────────────────────────

export function badge(text: string, tone: Tone = 'muted'): HTMLSpanElement {
  return el('span', { className: `badge tone-${tone}`, text });
}

export function ageSpan(time: string | undefined): HTMLSpanElement {
  const span = el('span', { className: 'age', text: formatAge(time) });
  if (time) {
    span.dataset.time = time;
    span.title = new Date(time).toLocaleString();
  }
  return span;
}

/** Keep every age label current. */
export function startAgeTicker(): void {
  setInterval(() => {
    const now = Date.now();
    document.querySelectorAll<HTMLElement>('[data-time]').forEach((node) => {
      node.textContent = formatAge(node.dataset.time, now);
    });
  }, 5000);
}

export function renderCell(cell: Cell, onOpen: (ref: ObjectRef) => void): HTMLElement {
  if (cell.dots) {
    const wrap = el('span', { className: 'dots' });
    for (const dot of cell.dots) {
      wrap.append(el('span', { className: `dot tone-${dot.tone}`, title: dot.title }));
    }
    return wrap;
  }
  if (cell.time !== undefined && !cell.text) {
    return ageSpan(cell.time);
  }
  if (cell.badge) {
    return badge(cell.text, cell.tone);
  }
  if (cell.link) {
    const link = el('a', { href: '#', className: 'link', text: cell.text, title: cell.title ?? '' });
    const ref = cell.link;
    link.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onOpen(ref);
    });
    return link;
  }
  const span = el('span', { text: cell.text, className: cell.tone ? `tone-text-${cell.tone}` : '' });
  // Long values are truncated by CSS; keep the full text in the tooltip.
  span.title = cell.title ?? (cell.text.length > 24 ? cell.text : '');
  if (cell.ratio !== undefined) {
    const bar = el('span', { className: 'mini-bar' }, el('span', { className: `mini-fill tone-bg-${cell.tone ?? 'ok'}` }));
    (bar.firstChild as HTMLElement).style.width = `${Math.min(100, Math.round(cell.ratio * 100))}%`;
    return el('span', { className: 'ratio', title: cell.title ?? '' }, bar, span);
  }
  return span;
}

export interface TableOptions {
  hideNamespace?: boolean;
  sort?: { column: string; desc: boolean };
  onSort?: (column: string) => void;
  onOpen: (ref: ObjectRef) => void;
  onRowClick?: (row: Row) => void;
  onAction?: (action: ActionId, row: Row) => void;
  selection?: Set<string>;
  selectionRows?: () => Row[];
  onSelect?: () => void;
  kindId: string;
  limit?: number;
  offset?: number;
  rowElements?: Map<string, { cells: Map<string, HTMLElement>; actions?: HTMLElement }>;
  /**
   * Rows rendered last time, keyed by row key. An entry is reused when the row
   * object and its selection are unchanged; the caller clears it when columns change.
   */
  renderedRows?: Map<string, RenderedRow>;
  /** User-set column widths in px; columns without one keep the default CSS limits. */
  widths?: Record<string, number>;
  /** Enables resize handles on the header; called when a drag or auto-fit ends. */
  onResize?: (column: string, width: number) => void;
}

const MIN_COLUMN_WIDTH = 40;

function setColumnWidth(node: HTMLElement, width: number | undefined): void {
  const value = width ? `${width}px` : '';
  node.style.width = value;
  node.style.minWidth = value;
  node.style.maxWidth = value;
}

/** Drag the right edge of a header to resize its column; double-click fits the widest value shown. */
function resizeHandle(th: HTMLElement, cells: () => HTMLElement[], onResize: (width: number) => void): HTMLElement {
  const handle = el('span', { className: 'col-resizer', title: 'Drag to resize, double-click to fit' });
  const apply = (width: number): void => {
    setColumnWidth(th, width);
    cells().forEach((cell) => setColumnWidth(cell, width));
  };
  handle.addEventListener('click', (event) => event.stopPropagation());
  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = th.getBoundingClientRect().width;
    let width = Math.round(startWidth);
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing-column');
    const move = (e: PointerEvent): void => {
      width = Math.max(MIN_COLUMN_WIDTH, Math.round(startWidth + e.clientX - startX));
      apply(width);
    };
    const up = (): void => {
      handle.removeEventListener('pointermove', move);
      document.body.classList.remove('resizing-column');
      onResize(width);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
    handle.addEventListener('pointercancel', up, { once: true });
  });
  handle.addEventListener('dblclick', (event) => {
    event.stopPropagation();
    const nodes = [th, ...cells()];
    nodes.forEach((node) => {
      setColumnWidth(node, undefined);
      node.style.maxWidth = 'none';
    });
    const width = Math.max(MIN_COLUMN_WIDTH, ...nodes.map((node) => node.scrollWidth + 1));
    apply(width);
    onResize(width);
  });
  return handle;
}

export interface RenderedRow {
  row: Row;
  selected: boolean;
  tr: HTMLTableRowElement;
  elements: { cells: Map<string, HTMLElement>; actions?: HTMLElement };
}

const cellCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const nameCollator = new Intl.Collator();

export function compareCells(a: Cell | undefined, b: Cell | undefined): number {
  const va = a?.sort ?? a?.text ?? '';
  const vb = b?.sort ?? b?.text ?? '';
  if (typeof va === 'number' && typeof vb === 'number') {
    return va - vb;
  }
  return cellCollator.compare(String(va), String(vb));
}

export function sortRows(data: TableData, sort?: { column: string; desc: boolean }): Row[] {
  if (!sort) {
    return data.rows;
  }
  const index = data.columns.findIndex((c) => c.id === sort.column);
  if (index < 0) {
    return data.rows;
  }
  const rows = [...data.rows].sort((a, b) => compareCells(a.cells[index], b.cells[index]) || nameCollator.compare(a.name, b.name));
  return sort.desc ? rows.reverse() : rows;
}

/** Replace only the action buttons when permission checks finish. */
export function renderRowActions(actions: HTMLElement, row: Row, onAction: (action: ActionId, row: Row) => void): void {
  clear(actions);
  const inline = row.actions.filter((a) => INLINE_ACTIONS.has(a));
  const rest = row.actions.filter((a) => !INLINE_ACTIONS.has(a));
  for (const action of inline) {
    actions.append(actionButton(action, () => onAction(action, row)));
  }
  if (rest.length === 1 && !inline.length) {
    actions.append(actionButton(rest[0], () => onAction(rest[0], row)));
  } else if (rest.length) {
    actions.append(
      iconButton('more', 'More actions', (event) =>
        showMenu(
          event.currentTarget as HTMLElement,
          rest.map((action) => ({
            label: ACTION_TITLES[action],
            icon: action,
            danger: action === 'delete' || action === 'helmUninstall',
            run: () => onAction(action, row)
          }))
        )
      )
    );
  }
}

/** Render a resource table; used by the table page and nested tables in details. */
export function renderTable(data: TableData, rows: Row[], options: TableOptions): HTMLTableElement {
  const visible: Array<{ column: Column; index: number }> = data.columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => !(options.hideNamespace && column.namespaceColumn));
  const table = el('table', { className: 'grid' });
  const head = el('tr');
  if (options.selection) {
    const all = el('input', { type: 'checkbox', title: 'Select all' });
    all.checked = rows.length > 0 && rows.every((r) => options.selection!.has(r.key));
    all.addEventListener('change', () => {
      for (const row of options.selectionRows?.() ?? rows) {
        if (all.checked) {
          options.selection!.add(row.key);
        } else {
          options.selection!.delete(row.key);
        }
      }
      options.onSelect?.();
    });
    head.append(el('th', { className: 'check' }, all));
  }
  // Cells per column of this render, for live resizing.
  const columnCells = new Map<string, HTMLElement[]>(visible.map(({ column }) => [column.id, []]));
  for (const { column } of visible) {
    const th = el('th', { className: `${column.align === 'right' ? 'right' : ''} col-${column.id}`.trim() }, column.title);
    if (options.onResize) {
      const id = column.id;
      th.append(resizeHandle(th, () => columnCells.get(id) ?? [], (width) => options.onResize!(id, width)));
    }
    setColumnWidth(th, options.widths?.[column.id]);
    if (options.onSort) {
      th.classList.add('sortable');
      if (options.sort?.column === column.id) {
        th.classList.add(options.sort.desc ? 'desc' : 'asc');
      }
      th.addEventListener('click', () => options.onSort!(column.id));
    }
    head.append(th);
  }
  if (options.onAction) {
    head.append(el('th', { className: 'actions' }));
  }
  table.append(el('thead', {}, head));

  const body = el('tbody');
  const offset = options.offset ?? 0;
  const limited = options.limit ? rows.slice(offset, offset + options.limit) : rows;
  const rendered = new Map<string, RenderedRow>();
  for (const row of limited) {
    const selected = !!options.selection?.has(row.key);
    const reused = options.renderedRows?.get(row.key);
    if (reused && reused.row === row && reused.selected === selected) {
      for (const [id, td] of reused.elements.cells) {
        setColumnWidth(td, options.widths?.[id]);
        columnCells.get(id)?.push(td);
      }
      options.rowElements?.set(row.key, reused.elements);
      rendered.set(row.key, reused);
      body.append(reused.tr);
      continue;
    }
    const tr = el('tr');
    const elements: { cells: Map<string, HTMLElement>; actions?: HTMLElement } = { cells: new Map() };
    options.rowElements?.set(row.key, elements);
    rendered.set(row.key, { row, selected, tr, elements });
    if (options.selection) {
      const box = el('input', { type: 'checkbox' });
      box.checked = options.selection.has(row.key);
      box.addEventListener('click', (event) => event.stopPropagation());
      box.addEventListener('change', () => {
        if (box.checked) {
          options.selection!.add(row.key);
        } else {
          options.selection!.delete(row.key);
        }
        options.onSelect?.();
      });
      tr.append(el('td', { className: 'check' }, box));
      if (options.selection.has(row.key)) {
        tr.classList.add('selected');
      }
    }
    for (const { column, index } of visible) {
      const cell = row.cells[index] ?? { text: '' };
      const td = el('td', { className: `${column.align === 'right' ? 'right' : ''} col-${column.id}` }, renderCell(cell, options.onOpen));
      setColumnWidth(td, options.widths?.[column.id]);
      columnCells.get(column.id)!.push(td);
      elements.cells.set(column.id, td);
      tr.append(td);
    }
    if (options.onAction) {
      const actions = el('td', { className: 'actions' });
      renderRowActions(actions, row, options.onAction);
      elements.actions = actions;
      tr.append(actions);
    }
    if (options.onRowClick) {
      tr.classList.add('clickable');
      tr.addEventListener('click', () => options.onRowClick!(row));
    }
    body.append(tr);
  }
  if (options.renderedRows) {
    options.renderedRows.clear();
    rendered.forEach((entry, key) => options.renderedRows!.set(key, entry));
  }
  table.append(body);
  return table;
}

// ───────────────────────────── charts ─────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, String(value));
  }
  return node;
}

export interface ChartLine {
  value: number;
  label: string;
  className: string;
}

/** Area chart of a metric over time with optional request/limit lines. */
export interface ExtraSeries {
  points: Array<{ t: number; v: number }>;
  label: string;
  className: string;
}

export function lineChart(points: Array<{ t: number; v: number }>, format: (v: number) => string, lines: ChartLine[] = [], className = 'series-cpu', extra: ExtraSeries[] = [], mainLabel = 'current'): HTMLElement {
  const width = 600;
  const height = 140;
  const pad = { left: 52, right: 8, top: 8, bottom: 18 };
  const wrap = el('div', { className: 'chart' });
  if (points.length === 0) {
    wrap.append(el('div', { className: 'chart-empty', text: 'Collecting data…' }));
    return wrap;
  }
  const maxValue = Math.max(...points.map((p) => p.v), ...extra.flatMap((s) => s.points.map((p) => p.v)), ...lines.map((l) => l.value), 0) * 1.1 || 1;
  const t0 = points[0].t;
  const t1 = Math.max(points[points.length - 1].t, t0 + 1);
  const x = (t: number): number => pad.left + ((t - t0) / (t1 - t0)) * (width - pad.left - pad.right);
  const y = (v: number): number => pad.top + (1 - v / maxValue) * (height - pad.top - pad.bottom);

  const chart = svg('svg', { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', class: 'chart-svg' });
  for (const fraction of [0, 0.5, 1]) {
    const v = maxValue * fraction;
    chart.append(svg('line', { x1: pad.left, x2: width - pad.right, y1: y(v), y2: y(v), class: 'grid-line' }));
    const label = svg('text', { x: pad.left - 6, y: y(v) + 4, class: 'axis-label', 'text-anchor': 'end' });
    label.textContent = format(v);
    chart.append(label);
  }
  if (points.length === 1) {
    chart.append(svg('circle', { cx: x(points[0].t), cy: y(points[0].v), r: 3, class: `point ${className}` }));
  } else {
    const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
    chart.append(svg('path', { d: `${path} L${x(t1)},${y(0)} L${x(t0)},${y(0)} Z`, class: `area ${className}` }));
    chart.append(svg('path', { d: path, class: `line ${className}` }));
  }
  for (const series of extra) {
    if (series.points.length > 1) {
      chart.append(svg('path', { d: series.points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' '), class: `line ${series.className}` }));
    }
  }
  for (const line of lines) {
    chart.append(svg('line', { x1: pad.left, x2: width - pad.right, y1: y(line.value), y2: y(line.value), class: `ref-line ${line.className}` }));
  }
  const minutes = Math.round((t1 - t0) / 60000);
  const span = svg('text', { x: width - pad.right, y: height - 4, class: 'axis-label', 'text-anchor': 'end' });
  span.textContent = minutes >= 120 ? `last ${Math.round(minutes / 60)} h` : minutes > 0 ? `last ${minutes} min` : 'now';
  chart.append(span);

  const cursor = svg('line', { x1: 0, x2: 0, y1: pad.top, y2: height - pad.bottom, class: 'cursor', visibility: 'hidden' });
  chart.append(cursor);
  const tip = el('div', { className: 'chart-tip' });
  chart.addEventListener('mousemove', (event) => {
    const rect = chart.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * width;
    let nearest = points[0];
    for (const p of points) {
      if (Math.abs(x(p.t) - px) < Math.abs(x(nearest.t) - px)) {
        nearest = p;
      }
    }
    cursor.setAttribute('x1', String(x(nearest.t)));
    cursor.setAttribute('x2', String(x(nearest.t)));
    cursor.setAttribute('visibility', 'visible');
    const others = extra.map((s) => {
      const match = s.points.find((p) => p.t === nearest.t);
      return match ? ` · ${s.label} ${format(match.v)}` : '';
    });
    tip.textContent = `${extra.length ? `${mainLabel} ` : ''}${format(nearest.v)}${others.join('')} · ${new Date(nearest.t).toLocaleString()}`;
    tip.style.display = 'block';
  });
  chart.addEventListener('mouseleave', () => {
    cursor.setAttribute('visibility', 'hidden');
    tip.style.display = 'none';
  });
  wrap.append(chart, tip);

  const legend = el('div', { className: 'legend' });
  legend.append(el('span', { className: `legend-item ${className}` }, el('i'), `${mainLabel} ${format(points[points.length - 1].v)}`));
  for (const series of extra) {
    const last = series.points[series.points.length - 1];
    legend.append(el('span', { className: `legend-item ${series.className}` }, el('i'), `${series.label} ${last ? format(last.v) : '—'}`));
  }
  for (const line of lines) {
    legend.append(el('span', { className: `legend-item ${line.className}` }, el('i'), `${line.label} ${format(line.value)}`));
  }
  wrap.append(legend);
  return wrap;
}

export const RANGES: Array<[number, string]> = [
  [3600, 'Last hour'],
  [6 * 3600, 'Last 6 hours'],
  [24 * 3600, 'Last 24 hours'],
  [7 * 24 * 3600, 'Last 7 days']
];

/** Range picker for Prometheus-backed charts. */
export function rangeSelect(current: number, onChange: (range: number) => void): HTMLSelectElement {
  const select = el('select', { title: 'Time range' });
  for (const [value, label] of RANGES) {
    select.append(el('option', { value: String(value), text: label }));
  }
  select.value = String(current);
  select.addEventListener('change', () => onChange(Number(select.value)));
  return select;
}

/** Concentric rings: usage, requests and limits relative to capacity (Lens style). */
export function rings(items: Array<{ label: string; value: number; className: string }>, capacity: number, format: (v: number) => string, title: string): HTMLElement {
  const size = 120;
  const chart = svg('svg', { viewBox: `0 0 ${size} ${size}`, class: 'rings' });
  items.forEach((item, i) => {
    const r = 52 - i * 12;
    const circumference = 2 * Math.PI * r;
    const ratio = capacity > 0 ? Math.min(1, item.value / capacity) : 0;
    chart.append(svg('circle', { cx: size / 2, cy: size / 2, r, class: 'ring-track' }));
    if (ratio <= 0) {
      return;
    }
    chart.append(
      svg('circle', {
        cx: size / 2,
        cy: size / 2,
        r,
        class: `ring ${item.className}${ratio < 0.03 ? ' flat' : ''}`,
        'stroke-dasharray': `${(ratio * circumference).toFixed(1)} ${circumference.toFixed(1)}`,
        transform: `rotate(-90 ${size / 2} ${size / 2})`
      })
    );
  });
  const pct = capacity > 0 ? Math.round((items[0].value / capacity) * 100) : 0;
  const center = svg('text', { x: size / 2, y: size / 2 + 6, 'text-anchor': 'middle', class: 'ring-center' });
  center.textContent = capacity > 0 ? `${pct}%` : '—';
  chart.append(center);

  const legend = el('div', { className: 'ring-legend' });
  for (const item of items) {
    legend.append(el('div', { className: `legend-item ${item.className}` }, el('i'), `${item.label}: ${format(item.value)}`));
  }
  legend.append(el('div', { className: 'legend-item muted' }, el('i'), `Capacity: ${format(capacity)}`));
  return el('div', { className: 'card rings-card' }, el('div', { className: 'card-title', text: title }), el('div', { className: 'rings-body' }, chart, legend));
}

export function usageBar(used: number, capacity: number, extra: Array<{ value: number; className: string; title: string }> = []): HTMLElement {
  const bar = el('div', { className: 'usage-bar' });
  const ratio = capacity > 0 ? Math.min(1, used / capacity) : 0;
  const fill = el('div', { className: `usage-fill ${ratio > 0.9 ? 'tone-bg-error' : ratio > 0.75 ? 'tone-bg-warn' : 'tone-bg-ok'}` });
  fill.style.width = `${(ratio * 100).toFixed(1)}%`;
  bar.append(fill);
  for (const mark of extra) {
    if (capacity > 0 && mark.value > 0) {
      const m = el('div', { className: `usage-mark ${mark.className}`, title: mark.title });
      m.style.left = `${Math.min(100, (mark.value / capacity) * 100).toFixed(1)}%`;
      bar.append(m);
    }
  }
  return bar;
}

export function errorBox(message: string): HTMLElement {
  return el('div', { className: 'error-box' }, el('strong', { text: 'Error: ' }), message);
}

export function notice(message: string): HTMLElement {
  return el('div', { className: 'notice', text: message });
}
