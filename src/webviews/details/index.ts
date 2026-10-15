import { formatBytes, formatCpu } from '../../core/format';
import type { ActionId, ContainerInfo, DetailsData, KeyValue, ObjectRef, SecretEntry, Section } from '../../core/protocol';
import {
  $,
  actionButton,
  ageSpan,
  badge,
  clear,
  el,
  errorBox,
  getState,
  icon,
  iconButton,
  lineChart,
  on,
  renderTable,
  request,
  setState,
  startAgeTicker,
  usageBar,
  initMeta,
  rangeSelect
} from '../shared/client';

interface UiState {
  collapsed: string[];
}

let ui = getState<UiState>({ collapsed: ['Annotations'] });
let current: { ref: ObjectRef; details: DetailsData; canGoBack: boolean } | undefined;
let pendingRender = false;
/** Keys of secret values shown in clear text. */
const revealed = new Set<string>();
/** A secret entry being edited blocks refresh re-renders. */
let editing: string | undefined;
/** Expanded <details> blocks, kept open across refreshes. */
const openBlocks = new Set<string>();
let lastJson = '';

function disclosure(key: string, summary: string, text: string): HTMLElement {
  const block = el('details', { className: 'env' }, el('summary', { text: summary }), el('pre', { className: 'code', text }));
  block.open = openBlocks.has(key);
  block.addEventListener('toggle', () => {
    if (block.open) {
      openBlocks.add(key);
    } else {
      openBlocks.delete(key);
    }
  });
  return block;
}

function hasTextSelection(): boolean {
  const selection = window.getSelection();
  return !!selection && !selection.isCollapsed && app.contains(selection.anchorNode);
}

const app = $('app');

function save(): void {
  setState(ui);
}

function openRef(ref: ObjectRef): void {
  void request('open', ref);
}

function runAction(action: ActionId, target?: ObjectRef): void {
  void request('action', { action, target });
}

function section(title: string, body: HTMLElement, extra?: HTMLElement): HTMLElement {
  const wrap = el('section', { className: `section ${ui.collapsed.includes(title) ? 'collapsed' : ''}` });
  const heading = el('h2', {}, title);
  if (extra) {
    heading.append(el('span', { className: 'spacer' }), extra);
    extra.addEventListener('click', (e) => e.stopPropagation());
  }
  heading.addEventListener('click', () => {
    const collapsed = wrap.classList.toggle('collapsed');
    ui.collapsed = collapsed ? [...ui.collapsed, title] : ui.collapsed.filter((t) => t !== title);
    save();
  });
  wrap.append(heading, el('div', { className: 'section-body' }, body));
  return wrap;
}

function kvValue(item: KeyValue): HTMLElement {
  const value = item.link
    ? (() => {
        const a = el('a', { href: '#', className: 'link', text: item.value });
        a.addEventListener('click', (e) => {
          e.preventDefault();
          openRef(item.link!);
        });
        return a;
      })()
    : el('span', { text: item.value || '—', className: item.tone ? `tone-text-${item.tone}` : '' });
  const wrap = el('span', { className: 'v' }, value);
  if (item.time) {
    wrap.append(' ', el('span', { className: 'muted' }, '(', ageSpan(item.time), ' ago)'));
  }
  return wrap;
}

function renderKv(items: KeyValue[]): HTMLElement {
  const grid = el('div', { className: 'kv' });
  for (const item of items) {
    grid.append(el('span', { className: 'k', text: item.key }), kvValue(item));
  }
  return grid;
}

function renderLabels(items: Array<{ key: string; value: string }>): HTMLElement {
  if (!items.length) {
    return el('span', { className: 'muted', text: 'None' });
  }
  const chips = el('div', { className: 'chips' });
  for (const { key, value } of items) {
    const chip = el('span', { className: 'chip', text: value ? `${key}=${value}` : key, title: `${key}=${value}\n(click to copy)` });
    chip.style.cursor = 'pointer';
    chip.addEventListener('click', () => void request('copy', { text: `${key}=${value}`, label: key }));
    chips.append(chip);
  }
  return chips;
}

function renderConditions(items: Extract<Section, { type: 'conditions' }>['items']): HTMLElement {
  if (!items.length) {
    return el('span', { className: 'muted', text: 'None' });
  }
  const table = el('table', { className: 'grid' });
  table.append(el('thead', {}, el('tr', {}, ...['Type', 'Status', 'Reason', 'Message', 'Last Transition'].map((t) => el('th', { text: t })))));
  const body = el('tbody');
  for (const c of items) {
    const healthy = c.status === 'True' ? !/Pressure|Unavailable|Failed|ReplicaFailure/.test(c.type) : /Pressure|Unavailable|Failed/.test(c.type);
    body.append(
      el(
        'tr',
        {},
        el('td', { text: c.type }),
        el('td', {}, badge(c.status, healthy ? 'ok' : c.status === 'Unknown' ? 'warn' : 'error')),
        el('td', { text: c.reason ?? '' }),
        el('td', { className: 'col-message', text: c.message ?? '' }),
        el('td', {}, ageSpan(c.time))
      )
    );
  }
  table.append(body);
  return table;
}

function renderContainers(items: ContainerInfo[], podName: string): HTMLElement {
  const cards = el('div', { className: 'cards' });
  for (const c of items) {
    const title = el('div', { className: 'card-title' }, el('span', { text: c.name }), c.init ? badge('init', 'muted') : null, badge(c.state, c.tone), el('span', { className: 'spacer' }));
    title.append(iconButton('logs', 'Logs', () => void request('containerAction', { action: 'logs', container: c.name })));
    if (c.restarts > 0) {
      title.append(iconButton('history', 'Logs of the previous instance', () => void request('containerAction', { action: 'logs', container: c.name, previous: true })));
    }
    if (c.state.startsWith('Running')) {
      title.append(
        iconButton('shell', 'Shell', () => void request('containerAction', { action: 'shell', container: c.name })),
        iconButton('download', 'Download a file or folder from the container', () => void request('containerAction', { action: 'download', container: c.name })),
        iconButton('upload', 'Upload a file or folder into the container', () => void request('containerAction', { action: 'upload', container: c.name }))
      );
    }
    if (!c.init && !c.name.startsWith('debugger-')) {
      title.append(iconButton('debug', 'Debug with an ephemeral container (kubectl debug)', () => void request('containerAction', { action: 'debug', container: c.name })));
    }
    const kv: KeyValue[] = [
      { key: 'Image', value: c.image },
      { key: 'Ready', value: c.ready ? 'Yes' : 'No', tone: c.ready ? undefined : 'warn' },
      { key: 'Restarts', value: String(c.restarts), tone: c.restarts > 0 ? 'warn' : undefined }
    ];
    if (c.lastState) {
      kv.push({ key: 'Last State', value: c.lastState, tone: 'warn' });
    }
    if (c.usage) {
      kv.push({ key: 'Usage', value: c.usage });
    }
    kv.push({ key: 'Requests', value: c.requests }, { key: 'Limits', value: c.limits });
    if (c.command) {
      kv.push({ key: 'Command', value: c.command });
    }
    const card = el('div', { className: 'card' }, title, renderKv(kv));
    if (c.ports.length) {
      const ports = el('div', { className: 'chips' });
      for (const p of c.ports) {
        const button = el('button', { className: 'btn', type: 'button', title: `Forward port ${p.port} of ${podName}` }, icon('forward'), `${p.port}/${p.protocol}${p.name ? ` (${p.name})` : ''}`);
        button.addEventListener('click', () => void request('forward', { port: p.port, kindId: 'pods', name: podName }));
        ports.append(button);
      }
      card.append(el('div', { className: 'kv' }, el('span', { className: 'k', text: 'Ports' }), ports));
    }
    if (c.mounts.length) {
      card.append(disclosure(`${c.name}:mounts`, `Mounts (${c.mounts.length})`, c.mounts.join('\n')));
    }
    if (c.env.length) {
      card.append(disclosure(`${c.name}:env`, `Environment (${c.env.length})`, c.env.map((e) => `${e.name}=${e.value}`).join('\n')));
    }
    cards.append(card);
  }
  return cards;
}

function renderMetrics(s: Extract<Section, { type: 'metrics' }>): HTMLElement {
  if (s.unavailable || !s.series.length) {
    return el('span', { className: 'muted', text: s.unavailable ?? 'No metrics.' });
  }
  const wrap = el('div', { className: 'charts' });
  for (const series of s.series) {
    const cpuLines = [
      series.cpuRequest ? { value: series.cpuRequest, label: 'requests', className: 'requests' } : undefined,
      series.cpuLimit ? { value: series.cpuLimit, label: 'limits', className: 'limits' } : undefined
    ].filter((l): l is { value: number; label: string; className: string } => !!l);
    const memoryLines = [
      series.memoryRequest ? { value: series.memoryRequest, label: 'requests', className: 'requests' } : undefined,
      series.memoryLimit ? { value: series.memoryLimit, label: 'limits', className: 'limits' } : undefined
    ].filter((l): l is { value: number; label: string; className: string } => !!l);
    wrap.append(
      el('div', { className: 'card' }, el('div', { className: 'card-title', text: `CPU · ${series.title}` }), lineChart(series.points.map((p) => ({ t: p.t, v: p.cpu })), formatCpu, cpuLines, 'series-cpu')),
      el('div', { className: 'card' }, el('div', { className: 'card-title', text: `Memory · ${series.title}` }), lineChart(series.points.map((p) => ({ t: p.t, v: p.memory })), formatBytes, memoryLines, 'series-memory'))
    );
    if (series.network?.length) {
      const rate = (v: number): string => `${formatBytes(v)}/s`;
      wrap.append(
        el(
          'div',
          { className: 'card' },
          el('div', { className: 'card-title', text: `Network · ${series.title}` }),
          lineChart(
            series.network.map((p) => ({ t: p.t, v: p.rx })),
            rate,
            [],
            'series-rx',
            [{ points: series.network.map((p) => ({ t: p.t, v: p.tx })), label: 'out', className: 'series-tx' }],
            'in'
          )
        )
      );
    }
  }
  return wrap;
}

function renderUsage(s: Extract<Section, { type: 'usage' }>): HTMLElement {
  const wrap = el('div');
  for (const item of s.items) {
    const fmt = item.format === 'cpu' ? formatCpu : item.format === 'memory' ? formatBytes : (v: number) => String(Math.round(v));
    const marks = [
      { value: item.requested ?? 0, className: 'requests', title: `Requests ${fmt(item.requested ?? 0)}` },
      { value: item.limit ?? 0, className: 'limits', title: `Limits ${fmt(item.limit ?? 0)}` }
    ];
    const text = [
      `${fmt(item.used)} used`,
      item.requested !== undefined ? `${fmt(item.requested)} requested` : '',
      item.limit !== undefined ? `${fmt(item.limit)} limits` : '',
      `of ${fmt(item.capacity)}`
    ]
      .filter(Boolean)
      .join(' · ');
    wrap.append(el('div', { className: 'usage-row' }, el('span', { text: item.label }), usageBar(item.used, item.capacity, marks), el('span', { className: 'muted', text })));
  }
  return wrap;
}

function renderSecret(s: Extract<Section, { type: 'secret' }>): HTMLElement {
  const wrap = el('div');
  const table = el('table', { className: 'grid secret-table' });
  const body = el('tbody');
  const isSecret = s.encoded;
  for (const entry of s.items) {
    body.append(...secretRow(entry, isSecret, s.editable));
  }
  if (editing === '\u0000new') {
    body.append(editRow({ key: '', value: '', binary: false, size: 0 }, true));
  }
  if (!s.items.length && editing !== '\u0000new') {
    body.append(el('tr', {}, el('td', { className: 'muted', text: 'No data.' })));
  }
  table.append(body);
  wrap.append(table);
  return wrap;
}

function secretRow(entry: SecretEntry, isSecret: boolean, editable: boolean): HTMLElement[] {
  if (editing === entry.key) {
    return [editRow(entry, false)];
  }
  const shown = !isSecret || revealed.has(entry.key);
  const valueCell = el('td', { className: 'value' });
  if (entry.binary) {
    valueCell.append(el('span', { className: 'muted', text: `binary data, ${entry.size} byte${entry.size === 1 ? '' : 's'} (the copy button copies base64)` }));
  } else if (shown) {
    valueCell.textContent = entry.value;
  } else {
    valueCell.append(el('span', { className: 'muted', text: '•'.repeat(Math.min(24, Math.max(6, entry.size))) + `  (${entry.size} byte${entry.size === 1 ? '' : 's'})` }));
  }
  const actions = el('td', { className: 'actions' });
  actions.style.opacity = '1';
  if (isSecret && !entry.binary) {
    actions.append(
      iconButton(shown ? 'eyeOff' : 'eye', shown ? 'Hide' : 'Show', () => {
        if (revealed.has(entry.key)) {
          revealed.delete(entry.key);
        } else {
          revealed.add(entry.key);
        }
        renderNow();
      })
    );
  }
  actions.append(iconButton('copy', entry.binary ? 'Copy base64' : 'Copy value', () => void request('copy', { text: entry.value, label: entry.key })));
  if (editable && !entry.binary) {
    actions.append(
      iconButton('edit', 'Edit', () => {
        editing = entry.key;
        renderNow();
      })
    );
  }
  if (editable) {
    actions.append(iconButton('delete', 'Delete key', () => void request('deleteEntry', { key: entry.key }), 'danger'));
  }
  return [el('tr', {}, el('td', { className: 'key', text: entry.key }), valueCell, actions)];
}

function editRow(entry: SecretEntry, isNew: boolean): HTMLElement {
  const keyInput = el('input', { type: 'text', value: entry.key, placeholder: 'key' });
  const valueInput = el('textarea', { value: entry.value, placeholder: 'value' });
  const status = el('span', { className: 'muted' });
  const saveButton = el('button', { className: 'btn primary', type: 'button', text: 'Save' });
  const cancelButton = el('button', { className: 'btn', type: 'button', text: 'Cancel' });
  saveButton.addEventListener('click', async () => {
    const key = keyInput.value.trim();
    if (!/^[-._a-zA-Z0-9]+$/.test(key)) {
      status.textContent = 'Keys may contain letters, digits, "-", "_" and "." only.';
      return;
    }
    saveButton.disabled = true;
    status.textContent = 'Saving…';
    try {
      await request('saveEntry', { key, value: valueInput.value, previousKey: isNew ? undefined : entry.key });
      editing = undefined;
      revealed.add(key);
      renderNow();
    } catch (err) {
      status.textContent = (err as Error).message;
      saveButton.disabled = false;
    }
  });
  cancelButton.addEventListener('click', () => {
    editing = undefined;
    renderNow();
  });
  setTimeout(() => (isNew ? keyInput : valueInput).focus(), 0);
  const td = el('td', { colSpan: 3 }, el('div', { className: 'secret-edit' }, el('div', { className: 'row' }, el('span', { className: 'muted', text: 'Key' }), keyInput), valueInput, el('div', { className: 'row' }, saveButton, cancelButton, status)));
  return el('tr', {}, td);
}

function renderPorts(s: Extract<Section, { type: 'ports' }>): HTMLElement {
  const table = el('table', { className: 'grid' });
  table.append(el('thead', {}, el('tr', {}, ...['Name', 'Port', 'Target Port', 'Protocol', 'Node Port', ''].map((t) => el('th', { text: t })))));
  const body = el('tbody');
  for (const p of s.items) {
    const forward = el('button', { className: 'btn', type: 'button' }, icon('forward'), 'Forward');
    forward.addEventListener('click', () => void request('forward', { port: p.port, kindId: 'services', name: s.serviceName }));
    body.append(
      el('tr', {}, el('td', { text: p.name ?? '—' }), el('td', { text: String(p.port) }), el('td', { text: p.targetPort }), el('td', { text: p.protocol }), el('td', { text: p.nodePort ? String(p.nodePort) : '—' }), el('td', { className: 'actions' }, forward))
    );
  }
  (body.querySelectorAll('td.actions') as NodeListOf<HTMLElement>).forEach((td) => (td.style.opacity = '1'));
  table.append(body);
  return table;
}

function renderRevisions(s: Extract<Section, { type: 'revisions' }>): HTMLElement {
  if (!s.items.length) {
    return el('span', { className: 'muted', text: 'No revisions.' });
  }
  const table = el('table', { className: 'grid' });
  const head = s.mode === 'helm' ? ['Revision', 'Status', 'Updated', 'Chart / Description', ''] : ['Revision', 'Created', 'Images / Change Cause', ''];
  table.append(el('thead', {}, el('tr', {}, ...head.map((t) => el('th', { text: t })))));
  const body = el('tbody');
  for (const r of s.items) {
    const actions = el('td', { className: 'actions' });
    actions.style.opacity = '1';
    const button = (label: string, iconName: string, action: string, title: string): void => {
      const b = el('button', { className: 'btn', type: 'button', title }, icon(iconName), label);
      b.addEventListener('click', () => void request('revision', { action, revision: r.revision }));
      actions.append(b);
    };
    if (s.mode === 'rollout') {
      if (!r.current) {
        button('Diff', 'diff', 'diff', 'Compare the pod template of this revision with the current one');
        button('Roll Back', 'history', 'rollback', `Roll back to revision ${r.revision}`);
      }
    } else if (!r.current) {
      button('Values', 'diff', 'diffValues', 'Diff the values of this revision with the latest');
      button('Manifest', 'diff', 'diffManifest', 'Diff the rendered manifest of this revision with the latest');
      button('Roll Back', 'history', 'helmRollback', `helm rollback to revision ${r.revision}`);
    }
    const revision = el('td', { className: r.current ? 'rev-current' : '', text: `${r.revision}${r.current ? ' (current)' : ''}` });
    const cells = s.mode === 'helm'
      ? [revision, el('td', {}, badge(r.status ?? '', r.status === 'deployed' ? 'ok' : r.status === 'failed' ? 'error' : 'muted')), el('td', {}, ageSpan(r.time)), el('td', { className: 'col-message', text: r.description })]
      : [revision, el('td', {}, ageSpan(r.time)), el('td', { className: 'col-message', text: r.description })];
    body.append(el('tr', {}, ...cells, actions));
  }
  table.append(body);
  return table;
}

function renderEvents(items: Extract<Section, { type: 'events' }>['items']): HTMLElement {
  if (!items.length) {
    return el('span', { className: 'muted', text: 'No events.' });
  }
  const wrap = el('div');
  for (const e of items) {
    wrap.append(
      el(
        'div',
        { className: 'event' },
        badge(e.type, e.type === 'Warning' ? 'warn' : 'muted'),
        el('strong', { text: `${e.reason}${e.count > 1 ? ` ×${e.count}` : ''}` }),
        el('span', { className: 'muted' }, e.source ? `${e.source} · ` : '', ageSpan(e.time)),
        el('span', { className: 'message', text: e.message })
      )
    );
  }
  return wrap;
}

function renderSection(s: Section): HTMLElement | undefined {
  switch (s.type) {
    case 'kv':
      return section(s.title, renderKv(s.items));
    case 'labels':
      return section(`${s.title}${s.items.length ? ` (${s.items.length})` : ''}`, renderLabels(s.items));
    case 'conditions':
      return s.items.length ? section(s.title, renderConditions(s.items)) : undefined;
    case 'containers':
      return section(s.title, renderContainers(s.items, s.podName));
    case 'metrics': {
      const extra = el('span', { className: 'muted metrics-source' });
      if (s.source === 'prometheus') {
        extra.append(`Prometheus ${s.endpoint ?? ''} `, rangeSelect(s.range ?? 3600, (range) => void request('metricsRange', { range })));
      } else if (!s.unavailable) {
        extra.append('metrics-server · history since the panel was opened');
      }
      return section(s.title, renderMetrics(s), extra);
    }
    case 'usage':
      return section(s.title, renderUsage(s));
    case 'table':
      return section(
        s.title,
        s.data.rows.length
          ? renderTable(s.data, s.data.rows, {
              kindId: '',
              hideNamespace: true,
              onOpen: openRef,
              onRowClick: (row) => openRef({ kindId: inferKind(s.title), name: row.name, namespace: row.namespace }),
              onAction: (action, row) => runAction(action, { kindId: inferKind(s.title), name: row.name, namespace: row.namespace })
            })
          : el('span', { className: 'muted', text: 'None' })
      );
    case 'secret': {
      const add = s.editable
        ? (() => {
            const b = el('button', { className: 'btn', type: 'button' }, icon('add'), 'Add key');
            b.addEventListener('click', () => {
              editing = '\u0000new';
              renderNow();
            });
            return b;
          })()
        : undefined;
      return section(s.title, renderSecret(s), add);
    }
    case 'ports':
      return section(s.title, renderPorts(s));
    case 'code': {
      const copy = iconButton('copy', 'Copy', () => void request('copy', { text: s.text, label: s.title }));
      return section(s.title, el('div', { className: 'code-wrap' }, el('pre', { className: 'code', text: s.text }), copy));
    }
    case 'events':
      return section(s.title, renderEvents(s.items));
    case 'revisions': {
      let extra: HTMLElement | undefined;
      if (s.mode === 'helm') {
        extra = el('button', { className: 'btn', type: 'button', title: 'Edit the values and run helm upgrade' }, icon('edit'), 'Edit Values & Upgrade');
        extra.addEventListener('click', () => void request('helmEditValues'));
      }
      return section(s.title, renderRevisions(s), extra);
    }
  }
}

function inferKind(title: string): string {
  return title.startsWith('Jobs') ? 'jobs' : 'pods';
}

function header(): HTMLElement {
  const toolbar = el('div', { className: 'toolbar' });
  if (current?.canGoBack) {
    toolbar.append(iconButton('back', 'Back', () => void request('back')));
  }
  if (current) {
    const d = current.details;
    toolbar.append(el('div', { className: 'header' }, el('h1', { text: d.title }), d.status ? badge(d.status.text, d.status.tone) : null, el('span', { className: 'subtitle', text: d.subtitle })));
  }
  toolbar.append(el('span', { className: 'spacer' }));
  if (current) {
    const pinned = !!current.details.pinned;
    toolbar.append(iconButton(pinned ? 'star' : 'starOff', pinned ? 'Unpin from Favorites' : 'Pin to Favorites', () => void request('togglePin')));
  }
  toolbar.append(iconButton('refresh', 'Refresh', () => void request('refresh')));
  return toolbar;
}

function renderNow(): void {
  pendingRender = false;
  const scroll = window.scrollY;
  clear(app);
  app.append(header());
  if (!current) {
    return;
  }
  const d = current.details;
  if (d.actions.length) {
    const bar = el('div', { className: 'actions-bar' });
    for (const action of d.actions) {
      bar.append(actionButton(action, () => runAction(action), true));
    }
    app.append(bar);
  }
  const page = el('div', { className: 'page' });
  for (const s of d.sections) {
    const node = renderSection(s);
    if (node) {
      page.append(node);
    }
  }
  app.append(page);
  window.scrollTo(0, scroll);
}

function render(): void {
  // Do not throw away an edit or a text selection in progress; render once it finishes.
  if (editing || hasTextSelection()) {
    pendingRender = true;
    return;
  }
  renderNow();
}

on<{ ref: ObjectRef; details: DetailsData; canGoBack: boolean }>('data', (payload) => {
  const changedObject = !current || current.ref.kindId !== payload.ref.kindId || current.ref.name !== payload.ref.name || current.ref.namespace !== payload.ref.namespace;
  if (changedObject) {
    revealed.clear();
    openBlocks.clear();
    editing = undefined;
  }
  current = payload;
  const json = JSON.stringify(payload);
  if (json === lastJson && !changedObject) {
    return;
  }
  lastJson = json;
  render();
  if (changedObject) {
    window.scrollTo(0, 0);
  }
});

on<{ ref: ObjectRef }>('loading', (payload) => {
  editing = undefined;
  lastJson = '';
  revealed.clear();
  current = undefined;
  clear(app);
  app.append(el('div', { className: 'loading' }, el('span', { className: 'spinner' }), `Loading ${payload.ref.name}…`));
});

on<{ ref: ObjectRef; message: string; canGoBack: boolean }>('error', (payload) => {
  clear(app);
  const toolbar = el('div', { className: 'toolbar' });
  if (payload.canGoBack) {
    toolbar.append(iconButton('back', 'Back', () => void request('back')));
  }
  toolbar.append(el('h1', { text: payload.ref.name }), el('span', { className: 'spacer' }), iconButton('refresh', 'Refresh', () => void request('refresh')));
  app.append(toolbar, errorBox(payload.message));
});

setInterval(() => {
  if (pendingRender && !editing && !hasTextSelection()) {
    renderNow();
  }
}, 1000);

startAgeTicker();
initMeta();
