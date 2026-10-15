import { formatBytes, formatCpu } from '../../core/format';
import type { DashboardData, ObjectRef } from '../../core/protocol';
import { $, ageSpan, badge, clear, el, errorBox, icon, iconButton, initMeta, lineChart, notice, on, rangeSelect, request, rings, startAgeTicker } from '../shared/client';

const app = $('app');
let data: DashboardData | undefined;
let error: string | undefined;

function open(ref: ObjectRef): void {
  void request('open', ref);
}

const titleEl = el('h1', { text: 'Cluster' });
const serverEl = el('span', { className: 'muted' });
const select = el('select', { title: 'Namespace' });
const body = el('div');
select.addEventListener('change', () => void request('setNamespace', { namespace: select.value }));
let namespacesKey = '';

clear(app);
const topologyButton = el('button', { className: 'btn', type: 'button', title: 'Relations between ingresses, services, workloads and pods' }, icon('graph'), 'Topology');
topologyButton.addEventListener('click', () => void request('topology'));

app.append(
  el('div', { className: 'toolbar' }, titleEl, serverEl, el('span', { className: 'spacer' }), topologyButton, select, iconButton('refresh', 'Refresh', () => void request('refresh'))),
  body
);

function updateToolbar(d: DashboardData): void {
  titleEl.textContent = d.context;
  serverEl.textContent = [d.server, d.version].filter(Boolean).join(' · ');
  const names = [...new Set([...d.namespaces, ...(d.namespace ? [d.namespace] : [])])].sort();
  const key = names.join('\u0000');
  // Rebuild the options only when they change, so an open dropdown is not closed by a refresh.
  if (key !== namespacesKey) {
    namespacesKey = key;
    clear(select);
    select.append(el('option', { value: '', text: 'All namespaces' }));
    for (const name of names) {
      select.append(el('option', { value: name, text: name }));
    }
  }
  if (document.activeElement !== select) {
    select.value = d.namespace;
  }
}

function render(): void {
  const scroll = window.scrollY;
  clear(body);
  if (data) {
    updateToolbar(data);
  }

  if (error) {
    body.append(errorBox(error));
  }
  if (!data) {
    if (!error) {
      body.append(el('div', { className: 'loading' }, el('span', { className: 'spinner' }), 'Loading cluster overview…'));
    }
    return;
  }
  for (const message of data.notices) {
    body.append(notice(message));
  }

  const d = data;
  const grid = el('div', { className: 'dash-grid' });

  const nodesCard = el(
    'div',
    { className: 'card workload' },
    el('div', { className: 'card-title', text: 'Nodes' }),
    el('div', { className: 'stat' }, `${d.nodes.ready}`, el('small', { text: ` / ${d.nodes.total} ready` }))
  );
  nodesCard.addEventListener('click', () => open({ kindId: 'nodes', name: '' }));
  if (d.nodes.total > d.nodes.ready) {
    nodesCard.append(badge(`${d.nodes.total - d.nodes.ready} not ready`, 'error'));
  }
  const podsCard = el(
    'div',
    { className: 'card' },
    el('div', { className: 'card-title', text: 'Pod Capacity' }),
    el('div', { className: 'stat' }, `${d.pods.usage}`, el('small', { text: d.pods.capacity ? ` / ${d.pods.capacity} allocatable` : '' }))
  );
  grid.append(nodesCard, podsCard);

  const scope = d.namespace ? `namespace ${d.namespace}` : 'cluster';
  grid.append(
    rings(
      [
        { label: 'Usage', value: d.cpu.usage, className: 'usage' },
        { label: 'Requests', value: d.cpu.requests, className: 'requests' },
        { label: 'Limits', value: d.cpu.limits, className: 'limits' }
      ],
      d.cpu.allocatable,
      formatCpu,
      `CPU · ${scope}`
    ),
    rings(
      [
        { label: 'Usage', value: d.memory.usage, className: 'usage' },
        { label: 'Requests', value: d.memory.requests, className: 'requests' },
        { label: 'Limits', value: d.memory.limits, className: 'limits' }
      ],
      d.memory.allocatable,
      formatBytes,
      `Memory · ${scope}`
    )
  );
  body.append(grid);

  if (d.history.length) {
    const header = el('div', { className: 'section' }, el('h2', {}, 'Usage', el('span', { className: 'spacer' })));
    const source = el('span', { className: 'muted metrics-source' });
    if (d.historySource === 'prometheus') {
      source.append('Prometheus ', rangeSelect(d.range, (range) => void request('metricsRange', { range })));
    } else {
      source.append('metrics-server · history since the panel was opened');
    }
    header.firstChild!.appendChild(source);
    body.append(header);
    const charts = el('div', { className: 'charts' });
    charts.style.margin = '0 14px';
    charts.append(
      el('div', { className: 'card' }, el('div', { className: 'card-title', text: 'CPU usage' }), lineChart(d.history.map((p) => ({ t: p.t, v: p.cpu })), formatCpu, [], 'series-cpu')),
      el('div', { className: 'card' }, el('div', { className: 'card-title', text: 'Memory usage' }), lineChart(d.history.map((p) => ({ t: p.t, v: p.memory })), formatBytes, [], 'series-memory'))
    );
    body.append(charts);
  }

  const workloads = el('div', { className: 'dash-grid' });
  for (const w of d.workloads) {
    const card = el('div', { className: 'card workload', title: `Open ${w.title}` }, el('div', { className: 'card-title', text: w.title }), el('div', { className: 'stat', text: String(w.total) }));
    const segments = el('div', { className: 'segments' });
    for (const [count, tone] of [
      [w.ok, 'ok'],
      [w.warn, 'warn'],
      [w.error, 'error']
    ] as const) {
      if (count > 0) {
        const span = el('span', { className: `tone-bg-${tone}` });
        span.style.width = `${(count / Math.max(1, w.total)) * 100}%`;
        segments.append(span);
      }
    }
    card.append(segments);
    const legend = el('div', { className: 'workload-legend' });
    if (w.ok) {
      legend.append(el('span', { className: 'tone-ok', text: `${w.ok} ok` }));
    }
    if (w.warn) {
      legend.append(el('span', { className: 'tone-warn', text: `${w.warn} pending` }));
    }
    if (w.error) {
      legend.append(el('span', { className: 'tone-error', text: `${w.error} failing` }));
    }
    card.append(legend);
    card.addEventListener('click', () => open({ kindId: w.kindId, name: '' }));
    workloads.append(card);
  }
  body.append(el('div', { className: 'section' }, el('h2', { text: 'Workloads' })), workloads);

  const warnings = el('section', { className: 'section' }, el('h2', { text: `Warnings (${d.warnings.length})` }));
  if (!d.warnings.length) {
    warnings.append(el('div', { className: 'muted', text: 'No warning events. 🎉' }));
  } else {
    const table = el('table', { className: 'grid' });
    table.append(el('thead', {}, el('tr', {}, ...['Reason', 'Object', 'Message', 'Count', 'Age'].map((t) => el('th', { text: t, className: t === 'Count' || t === 'Age' ? 'right' : '' })))));
    const body = el('tbody');
    for (const w of d.warnings) {
      const object = w.link
        ? (() => {
            const a = el('a', { href: '#', className: 'link', text: `${w.namespace ? `${w.namespace}/` : ''}${w.object}` });
            a.addEventListener('click', (e) => {
              e.preventDefault();
              open(w.link!);
            });
            return a;
          })()
        : el('span', { text: w.object });
      body.append(
        el(
          'tr',
          {},
          el('td', {}, badge(w.reason, 'warn')),
          el('td', {}, object),
          el('td', { className: 'col-message', text: w.message }),
          el('td', { className: 'right', text: String(w.count) }),
          el('td', { className: 'right' }, ageSpan(w.time))
        )
      );
    }
    table.append(body);
    warnings.append(table);
  }
  body.append(warnings);
  window.scrollTo(0, scroll);
}

on<DashboardData>('data', (payload) => {
  data = payload;
  error = undefined;
  render();
});

on<{ message: string }>('error', (payload) => {
  error = payload.message;
  render();
});

render();
startAgeTicker();
initMeta();
