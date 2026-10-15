import type { TopologyGraph, TopologyNode } from '../../core/topology';
import { $, clear, el, errorBox, iconButton, initMeta, notice, on, request } from '../shared/client';

const SVG_NS = 'http://www.w3.org/2000/svg';
const NODE_W = 190;
const NODE_H = 34;
const COL_GAP = 70;
const ROW_GAP = 10;
const TOP = 28;

const app = $('app');
const titleEl = el('h1', { text: 'Topology' });
const searchInput = el('input', { type: 'search', placeholder: 'Highlight by name…' });
const body = el('div', { className: 'topology' });
let graph: TopologyGraph | undefined;
let lastJson = '';

clear(app);
app.append(el('div', { className: 'toolbar' }, titleEl, el('span', { className: 'spacer' }), searchInput, iconButton('refresh', 'Refresh', () => void request('refresh'))), body);

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, String(v));
  }
  return node;
}

/** Order each column by the mean position of its neighbours (barycentre), a few sweeps both ways. */
function layout(g: TopologyGraph): Map<string, { x: number; y: number }> {
  const columns: TopologyNode[][] = g.columns.map(() => []);
  for (const node of g.nodes) {
    columns[node.column].push(node);
  }
  columns.forEach((col) => col.sort((a, b) => a.name.localeCompare(b.name)));
  const neighbours = new Map<string, string[]>();
  for (const e of g.edges) {
    neighbours.set(e.from, [...(neighbours.get(e.from) ?? []), e.to]);
    neighbours.set(e.to, [...(neighbours.get(e.to) ?? []), e.from]);
  }
  const index = new Map<string, number>();
  const reindex = (): void => columns.forEach((col) => col.forEach((n, i) => index.set(n.id, i)));
  reindex();
  for (let sweep = 0; sweep < 4; sweep += 1) {
    const order = sweep % 2 === 0 ? columns : [...columns].reverse();
    for (const col of order) {
      const score = (n: TopologyNode): number => {
        const ns = (neighbours.get(n.id) ?? []).map((id) => index.get(id)).filter((i): i is number => i !== undefined);
        return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : index.get(n.id)!;
      };
      col.sort((a, b) => score(a) - score(b));
      reindex();
    }
  }
  const positions = new Map<string, { x: number; y: number }>();
  const used = columns.map((col, i) => ({ col, i })).filter(({ col }) => col.length);
  used.forEach(({ col }, visibleIndex) => {
    col.forEach((node, row) => positions.set(node.id, { x: visibleIndex * (NODE_W + COL_GAP), y: TOP + row * (NODE_H + ROW_GAP) }));
  });
  return positions;
}

function render(): void {
  clear(body);
  if (!graph) {
    return;
  }
  titleEl.textContent = `Topology · ${graph.namespace}`;
  if (graph.truncated) {
    body.append(notice(graph.truncated));
  }
  if (!graph.nodes.length) {
    body.append(el('div', { className: 'empty', text: 'Nothing in this namespace.' }));
    return;
  }
  const positions = layout(graph);
  const width = Math.max(...[...positions.values()].map((p) => p.x)) + NODE_W + 10;
  const height = Math.max(...[...positions.values()].map((p) => p.y)) + NODE_H + 10;
  const root = svg('svg', { width, height, viewBox: `0 0 ${width} ${height}` });

  const usedColumns = graph.columns.filter((_, i) => graph!.nodes.some((n) => n.column === i));
  usedColumns.forEach((title, i) => {
    const t = svg('text', { x: i * (NODE_W + COL_GAP), y: 12, class: 'topo-column-title' });
    t.textContent = title;
    root.append(t);
  });

  const edgeEls: Array<{ el: SVGPathElement; from: string; to: string }> = [];
  for (const e of graph.edges) {
    const a = positions.get(e.from);
    const b = positions.get(e.to);
    if (!a || !b) {
      continue;
    }
    const [left, right] = a.x <= b.x ? [a, b] : [b, a];
    const x1 = left.x + NODE_W;
    const y1 = left.y + NODE_H / 2;
    const x2 = right.x;
    const y2 = right.y + NODE_H / 2;
    const mid = (x1 + x2) / 2;
    const path = svg('path', { d: `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`, class: 'topo-edge' });
    root.append(path);
    edgeEls.push({ el: path, from: e.from, to: e.to });
  }

  const query = searchInput.value.trim().toLowerCase();
  for (const node of graph.nodes) {
    const p = positions.get(node.id)!;
    const g = svg('g', { class: 'topo-node', transform: `translate(${p.x},${p.y})` });
    g.append(svg('rect', { width: NODE_W, height: NODE_H, rx: 4 }));
    g.append(svg('rect', { width: 4, height: NODE_H, class: `status tone-${node.tone}` }));
    const kind = svg('text', { x: 10, y: 12, class: 'kind' });
    kind.textContent = `${node.kind} · ${node.status}`.slice(0, 34);
    const name = svg('text', { x: 10, y: 26 });
    name.textContent = node.name.length > 30 ? `${node.name.slice(0, 29)}…` : node.name;
    const tip = svg('title', {});
    tip.textContent = `${node.kind} ${node.name}\n${node.status}`;
    g.append(kind, name, tip);
    if (query && !node.name.toLowerCase().includes(query)) {
      g.setAttribute('opacity', '0.3');
    }
    g.addEventListener('mouseenter', () => edgeEls.forEach((e) => e.el.classList.toggle('highlight', e.from === node.id || e.to === node.id)));
    g.addEventListener('mouseleave', () => edgeEls.forEach((e) => e.el.classList.remove('highlight')));
    g.addEventListener('click', () => void request('open', { kindId: node.kindId, name: node.name }));
    root.append(g);
  }
  body.append(root);
}

searchInput.addEventListener('input', () => render());

on<TopologyGraph>('data', (payload) => {
  const json = JSON.stringify(payload);
  if (json === lastJson) {
    return;
  }
  lastJson = json;
  graph = payload;
  render();
});
on<{ message: string }>('error', (payload) => {
  clear(body);
  body.append(errorBox(payload.message));
});

body.append(el('div', { className: 'loading' }, el('span', { className: 'spinner' }), 'Building topology…'));
initMeta();
