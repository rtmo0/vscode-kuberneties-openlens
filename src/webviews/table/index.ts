import type { ActionId, ObjectRef, Row, TableData, TableInit } from '../../core/protocol';
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
  request,
  setState,
  sortRows,
  startAgeTicker,
  initMeta
} from '../shared/client';

interface UiState {
  search: string;
  sort?: { column: string; desc: boolean };
}

const PAGE = 300;
const DEFAULT_SORT: Record<string, { column: string; desc: boolean }> = {
  events: { column: 'lastSeen', desc: false }
};

let ui = getState<UiState>({ search: '' });
let init: TableInit | undefined;
let data: TableData | undefined;
let error: string | undefined;
let limit = PAGE;
const selection = new Set<string>();

const app = $('app');
document.body.classList.add('page-table');

const titleEl = el('h1');
const countEl = el('span', { className: 'count' });
const namespaceSelect = el('select', { title: 'Namespace' });
const searchInput = el('input', { type: 'search', placeholder: 'Search name, labels, any column…', value: ui.search });
const bulk = el('span', { className: 'bulk' });
const notices = el('div');
const content = el('div');

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
    iconButton('refresh', 'Refresh', () => void request('refresh'))
  );
  clear(app);
  app.append(toolbar, notices, content);
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

function matches(row: Row, query: string): boolean {
  if (!query) {
    return true;
  }
  const haystack = [row.name, row.namespace ?? '', row.search ?? '', ...row.cells.map((c) => c.text)].join(' ').toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

function visibleRows(): Row[] {
  if (!data) {
    return [];
  }
  const sort = ui.sort ?? DEFAULT_SORT[init?.kindId ?? ''] ?? { column: 'name', desc: false };
  return sortRows(data, sort).filter((row) => matches(row, ui.search.trim()));
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

function render(): void {
  clear(notices);
  if (error) {
    notices.append(errorBox(error));
  }
  if (data?.notice) {
    notices.append(notice(data.notice));
  }
  if (!data) {
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
  const scroll = window.scrollY;
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
        onSort: (column) => {
          const current = ui.sort ?? DEFAULT_SORT[init?.kindId ?? ''] ?? { column: 'name', desc: false };
          ui.sort = { column, desc: current.column === column ? !current.desc : false };
          save();
          render();
        },
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
        onSelect: () => render(),
        limit
      })
    );
    if (rows.length > limit) {
      const more = el('button', { className: 'btn', type: 'button', text: `Show ${Math.min(PAGE, rows.length - limit)} more (${rows.length - limit} hidden)` });
      more.addEventListener('click', () => {
        limit += PAGE;
        render();
      });
      content.append(el('div', { className: 'more' }, more));
    }
  }
  window.scrollTo(0, scroll);
  renderBulk();
}

searchInput.addEventListener(
  'input',
  debounce(() => {
    ui.search = searchInput.value;
    limit = PAGE;
    save();
    render();
  }, 150)
);

namespaceSelect.addEventListener('change', () => {
  selection.clear();
  limit = PAGE;
  void request('setNamespace', { namespace: namespaceSelect.value });
});

document.addEventListener('keydown', (event) => {
  if (event.key === '/' && document.activeElement !== searchInput) {
    event.preventDefault();
    searchInput.focus();
  } else if (event.key === 'Escape' && document.activeElement === searchInput) {
    searchInput.value = '';
    ui.search = '';
    save();
    render();
  }
});

let lastJson = '';

on<TableData & { namespace: string }>('data', (payload) => {
  const json = JSON.stringify(payload);
  if (json === lastJson && !error) {
    return;
  }
  lastJson = json;
  data = payload;
  error = undefined;
  if (init?.namespaced && namespaceSelect.value !== payload.namespace) {
    fillNamespaces(payload.namespace);
  }
  render();
});

on<{ message: string }>('error', (payload) => {
  error = payload.message;
  render();
});

async function start(): Promise<void> {
  buildToolbar();
  try {
    init = await request<TableInit>('init');
    titleEl.textContent = init.title;
    document.title = init.title;
    fillNamespaces(init.namespace);
  } catch (err) {
    error = (err as Error).message;
  }
  render();
  startAgeTicker();
  initMeta();
}

void start();
