import type { ActionId, ObjectRef, ResourceTableData, Row, TableData, TableInit, TablePatch, TableSupplement } from '../../core/protocol';
import {
  $,
  ACTION_TITLES,
  clear,
  debounce,
  el,
  errorBox,
  getState,
  icon,
  iconButton,
  notice,
  on,
  renderTable,
  renderCell,
  renderRowActions,
  request,
  setState,
  sortRows,
  startAgeTicker,
  initMeta,
  RenderedRow
} from '../shared/client';

interface UiState {
  search: string;
  sort?: { column: string; desc: boolean };
  /** Column widths per resource kind, set by dragging the header edge. */
  widths?: Record<string, Record<string, number>>;
}

const PAGE = 100;
const DEFAULT_SORT: Record<string, { column: string; desc: boolean }> = {
  events: { column: 'lastSeen', desc: false }
};

let ui = getState<UiState>({ search: '' });
let init: TableInit | undefined;
let data: ResourceTableData | undefined;
let rowsByKey = new Map<string, Row>();
const rowElements = new Map<string, { cells: Map<string, HTMLElement>; actions?: HTMLElement }>();
/** DOM rows of the current page, reused when their row object did not change. */
const renderedRows = new Map<string, RenderedRow>();
let renderedLayout = '';
let paintedScope: number | undefined;
let metricsNotice = '';
let error: string | undefined;
let page = 0;
let renderedPage = '';
let renderPending = false;
let sorting = false;
let loading = true;
let requestedNamespace: string | undefined;
const selection = new Set<string>();
const searchText = new WeakMap<Row, string>();
let visibleCache: { data: TableData; query: string; column: string; desc: boolean; rows: Row[] } | undefined;

const app = $('app');
document.body.classList.add('page-table');

const titleEl = el('h1');
const countEl = el('span', { className: 'count' });
const namespaceSelect = el('select', { title: 'Namespace' });
const searchInput = el('input', { type: 'search', placeholder: 'Search name, labels, any column…', value: ui.search });
const bulk = el('span', { className: 'bulk' });
const notices = el('div');
const content = el('div');
const sortingOverlay = el('div', { className: 'sorting-overlay' }, el('span', { className: 'spinner' }), 'Sorting…');
sortingOverlay.setAttribute('role', 'status');
sortingOverlay.setAttribute('aria-live', 'polite');
sortingOverlay.setAttribute('aria-hidden', 'true');

function save(): void {
  setState(ui);
}

function buildToolbar(): void {
  const toolbar = el(
    'div',
    { className: 'toolbar' },
    titleEl,
    countEl,
    el('span', { className: 'spacer' }),
    bulk,
    namespaceSelect,
    el('label', { className: 'search' }, icon('search'), searchInput),
    iconButton('refresh', 'Refresh', () => void load('refresh'))
  );
  clear(app);
  app.append(toolbar, notices, content, sortingOverlay);
}

function fillNamespaces(current: string): void {
  if (!init?.namespaced) {
    namespaceSelect.style.display = 'none';
    return;
  }
  const names = new Set(init.namespaces);
  if (current) {
    names.add(current);
  }
  clear(namespaceSelect);
  namespaceSelect.append(el('option', { value: '', text: 'All namespaces' }));
  for (const name of [...names].sort()) {
    namespaceSelect.append(el('option', { value: name, text: name }));
  }
  namespaceSelect.value = current;
}

function matches(row: Row, terms: string[]): boolean {
  let haystack = searchText.get(row);
  if (haystack === undefined) {
    haystack = [row.name, row.namespace ?? '', row.search ?? '', ...row.cells.map((c) => c.text)].join(' ').toLowerCase();
    searchText.set(row, haystack);
  }
  return terms.every((term) => haystack.includes(term));
}

function visibleRows(): Row[] {
  if (!data) {
    return [];
  }
  const query = ui.search.trim().toLowerCase();
  const sort = ui.sort ?? DEFAULT_SORT[init?.kindId ?? ''] ?? { column: 'name', desc: false };
  if (visibleCache?.data === data && visibleCache.query === query && visibleCache.column === sort.column && visibleCache.desc === sort.desc) {
    return visibleCache.rows;
  }

  const terms = query.split(/\s+/).filter(Boolean);
  const filtered = terms.length ? data.rows.filter((row) => matches(row, terms)) : data.rows;
  const rows = sortRows({ ...data, rows: filtered }, sort);
  visibleCache = { data, query, column: sort.column, desc: sort.desc, rows };
  return rows;
}

function setSorting(value: boolean): void {
  sorting = value;
  sortingOverlay.classList.toggle('visible', value);
  sortingOverlay.setAttribute('aria-hidden', String(!value));
}

function waitForPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

async function sortBy(column: string): Promise<void> {
  if (sorting) {
    return;
  }
  const current = ui.sort ?? DEFAULT_SORT[init?.kindId ?? ''] ?? { column: 'name', desc: false };
  ui.sort = { column, desc: current.column === column ? !current.desc : false };
  page = 0;
  save();
  setSorting(true);
  await waitForPaint();
  try {
    render();
  } finally {
    setSorting(false);
  }
}

function openRef(ref: ObjectRef): void {
  void request('open', ref);
}

async function runAction(action: ActionId, rows: Row[]): Promise<void> {
  const targets = rows.map((r) => ({ name: r.name, namespace: r.namespace }));
  const changed = await request<boolean>('action', { action, targets }).catch(() => false);
  if (changed && action === 'delete') {
    for (const row of rows) {
      selection.delete(row.key);
    }
  }
}

function renderBulk(): void {
  clear(bulk);
  if (!data || !init) {
    return;
  }
  const selected = data.rows.filter((r) => selection.has(r.key));
  bulk.classList.toggle('visible', selected.length > 0);
  if (!selected.length) {
    return;
  }
  bulk.append(el('span', { className: 'muted', text: `${selected.length} selected` }));
  const available = init.bulkActions.filter((action) => selected.every((r) => r.actions.includes(action)));
  for (const action of available) {
    const button = el('button', { className: `btn ${action === 'delete' ? 'danger' : ''}`, type: 'button' }, icon(action), ACTION_TITLES[action]);
    button.addEventListener('click', () => void runAction(action, selected));
    bulk.append(button);
  }
  bulk.append(iconButton('back', 'Clear selection', () => {
    selection.clear();
    render();
  }));
}

async function load(type: string, payload?: unknown): Promise<void> {
  loading = true;
  error = undefined;
  render();
  try {
    await request(type, payload);
  } catch (err) {
    loading = false;
    error = (err as Error).message;
    render();
  }
}

function render(): void {
  content.setAttribute('aria-busy', String(loading));
  clear(notices);
  if (loading) {
    const indicator = el('div', { className: 'loading' }, el('span', { className: 'spinner' }), data?.loading ?? (data ? 'Refreshing…' : 'Loading resources…'));
    indicator.setAttribute('role', 'status');
    notices.append(indicator);
  }
  if (error) {
    notices.append(errorBox(error));
  }
  if (data?.notice) {
    notices.append(notice(data.notice));
  }
  if (metricsNotice) {
    notices.append(notice(`Metrics: ${metricsNotice}`));
  }
  if (!data) {
    renderedPage = '';
    rowElements.clear();
    renderedRows.clear();
    clear(content);
    renderBulk();
    return;
  }
  // Drop selections of rows that are gone.
  const keys = new Set(data.rows.map((r) => r.key));
  for (const key of [...selection]) {
    if (!keys.has(key)) {
      selection.delete(key);
    }
  }

  const rows = visibleRows();
  countEl.textContent = ui.search ? `${rows.length} of ${data.rows.length}` : String(data.rows.length);
  page = Math.min(page, Math.max(0, Math.ceil(rows.length / PAGE) - 1));
  const offset = page * PAGE;
  // Updates outside this page must not destroy and recreate the visible DOM.
  const signature = pageSignature(rows);
  if (signature === renderedPage) {
    renderBulk();
    acknowledgePaint();
    return;
  }
  renderedPage = signature;
  const scroll = window.scrollY;
  rowElements.clear();
  const layout = JSON.stringify([data.scope, data.columns, namespaceSelect.value]);
  if (layout !== renderedLayout) {
    renderedLayout = layout;
    renderedRows.clear();
  }
  clear(content);
  if (data.rows.length === 0) {
    content.append(el('div', { className: 'empty', text: `No ${init?.title.toLowerCase() ?? 'items'} found${namespaceSelect.value ? ` in namespace ${namespaceSelect.value}` : ''}.` }));
  } else if (rows.length === 0) {
    content.append(el('div', { className: 'empty', text: 'Nothing matches the search.' }));
  } else {
    content.append(
      renderTable(data, rows, {
        kindId: init?.kindId ?? '',
        hideNamespace: !!namespaceSelect.value,
        sort: ui.sort ?? DEFAULT_SORT[init?.kindId ?? ''] ?? { column: 'name', desc: false },
        onSort: (column) => void sortBy(column),
        onOpen: openRef,
        onRowClick: (row) => {
          if (init?.kindId === 'crds') {
            const link = row.cells[0]?.link;
            if (link) {
              openRef(link);
              return;
            }
          }
          openRef({ kindId: init?.kindId ?? '', name: row.name, namespace: row.namespace });
        },
        onAction: (action, row) => void runAction(action, [row]),
        selection,
        selectionRows: visibleRows,
        rowElements,
        renderedRows,
        widths: ui.widths?.[init?.kindId ?? ''],
        onResize: (column, width) => {
          const kind = init?.kindId ?? '';
          ui.widths = { ...ui.widths, [kind]: { ...ui.widths?.[kind], [column]: width } };
          save();
        },
        onSelect: () => render(),
        limit: PAGE,
        offset
      })
    );
    if (rows.length > PAGE) {
      const previous = el('button', { className: 'btn', type: 'button', text: 'Previous' });
      const next = el('button', { className: 'btn', type: 'button', text: 'Next' });
      previous.disabled = page === 0;
      next.disabled = offset + PAGE >= rows.length;
      previous.addEventListener('click', () => {
        page--;
        render();
      });
      next.addEventListener('click', () => {
        page++;
        render();
      });
      content.append(el('div', { className: 'more' }, previous,
        el('span', { className: 'muted', text: ` ${offset + 1}–${Math.min(offset + PAGE, rows.length)} of ${rows.length} ` }), next));
    }
  }
  window.scrollTo(0, scroll);
  renderBulk();
  acknowledgePaint();
}

function pageSignature(rows: Row[]): string {
  return JSON.stringify([
    data?.scope, data?.columns, rows.slice(page * PAGE, (page + 1) * PAGE), rows.length, data?.rows.length,
    page, ui.sort, init?.kindId, namespaceSelect.value, [...selection],
    rows.length > 0 && rows.every((row) => selection.has(row.key))
  ]);
}

function acknowledgePaint(): void {
  if (!data || paintedScope === data.scope) { return; }
  const scope = data.scope;
  paintedScope = scope;
  // Let the browser paint the rows before asking the host to start optional API work.
  requestAnimationFrame(() => setTimeout(() => {
    if (data?.scope === scope) { void request('painted', { scope }); }
  }, 0));
}

searchInput.addEventListener(
  'input',
  debounce(() => {
    ui.search = searchInput.value;
    page = 0;
    save();
    render();
  }, 150)
);

namespaceSelect.addEventListener('change', () => {
  selection.clear();
  page = 0;
  requestedNamespace = namespaceSelect.value;
  data = undefined;
  rowsByKey.clear();
  metricsNotice = '';
  visibleCache = undefined;
  countEl.textContent = '';
  void load('setNamespace', { namespace: namespaceSelect.value });
});

document.addEventListener('keydown', (event) => {
  if (event.key === '/' && document.activeElement !== searchInput) {
    event.preventDefault();
    searchInput.focus();
  } else if (event.key === 'Escape' && document.activeElement === searchInput) {
    searchInput.value = '';
    ui.search = '';
    page = 0;
    save();
    render();
  }
});

function scheduleRender(): void {
  if (renderPending) {
    return;
  }
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    render();
  });
}

let namespaces: string[] | undefined;
on<string[]>('namespaces', (payload) => {
  namespaces = payload;
  if (init) {
    init.namespaces = payload;
    fillNamespaces(namespaceSelect.value);
  }
});

on<ResourceTableData>('data', (payload) => {
  if (requestedNamespace !== undefined && payload.namespace !== requestedNamespace) {
    return;
  }
  requestedNamespace = undefined;
  loading = !!payload.loading;
  if (data?.scope !== payload.scope) { metricsNotice = ''; }
  data = payload;
  rowsByKey = new Map(payload.rows.map((row) => [row.key, row]));
  visibleCache = undefined;
  error = undefined;
  if (init?.namespaced && namespaceSelect.value !== payload.namespace) {
    fillNamespaces(payload.namespace);
  }
  scheduleRender();
});

on<TablePatch>('patch', (payload) => {
  if (requestedNamespace !== undefined || !data || payload.scope !== data.scope) {
    return;
  }
  loading = !!payload.loading;
  for (const key of payload.remove) {
    rowsByKey.delete(key);
  }
  for (const row of payload.upsert) {
    rowsByKey.set(row.key, row);
  }
  const changed = payload.upsert.length > 0 || payload.remove.length > 0;
  data = {
    ...data,
    rows: changed ? [...rowsByKey.values()] : data.rows,
    notice: payload.notice,
    loading: payload.loading,
    metricsAvailable: payload.metricsAvailable
  };
  if (changed) {
    visibleCache = undefined;
  } else if (visibleCache) {
    visibleCache.data = data;
  }
  error = undefined;
  scheduleRender();
});

on<TableSupplement>('supplement', (payload) => {
  if (!data || payload.scope !== data.scope) { return; }
  let reorder = false;
  const sort = ui.sort ?? DEFAULT_SORT[init?.kindId ?? ''] ?? { column: 'name', desc: false };
  for (const update of payload.rows) {
    const row = rowsByKey.get(update.key);
    if (!row) { continue; }
    const elements = rowElements.get(row.key);
    for (const [column, cell] of Object.entries(update.cells ?? {})) {
      const index = data.columns.findIndex((entry) => entry.id === column);
      if (index < 0) { continue; }
      row.cells[index] = cell;
      searchText.delete(row);
      reorder ||= !!ui.search.trim() || sort.column === column;
      const td = elements?.cells.get(column);
      if (td) {
        clear(td);
        td.append(renderCell(cell, openRef));
      }
    }
    if (update.actions) {
      row.actions = update.actions;
      if (elements?.actions) {
        renderRowActions(elements.actions, row, (action, selected) => void runAction(action, [selected]));
      }
    }
  }
  const noticeChanged = payload.metricsNotice !== undefined && payload.metricsNotice !== metricsNotice;
  if (payload.metricsNotice !== undefined) { metricsNotice = payload.metricsNotice; }
  if (reorder) { visibleCache = undefined; }
  else if (!renderPending) { renderedPage = pageSignature(visibleRows()); }
  if (reorder || noticeChanged) { scheduleRender(); }
  renderBulk();
});

on<{ message: string }>('error', (payload) => {
  loading = false;
  error = payload.message;
  render();
});

async function start(): Promise<void> {
  buildToolbar();
  render();
  try {
    init = await request<TableInit>('init');
    init.namespaces = namespaces ?? init.namespaces;
    titleEl.textContent = init.title;
    document.title = init.title;
    fillNamespaces(init.namespace);
  } catch (err) {
    loading = false;
    error = (err as Error).message;
  }
  render();
  startAgeTicker();
  initMeta();
}

void start();
