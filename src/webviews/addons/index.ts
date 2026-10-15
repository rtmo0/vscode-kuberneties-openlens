import { $, badge, clear, el, errorBox, icon, iconButton, initMeta, notice, request } from '../shared/client';

interface AddonView {
  id: string;
  title: string;
  category: string;
  description: string;
  docs: string;
  source: string;
  namespace?: string;
  needsHelm: boolean;
  status: { installed: boolean; managed: boolean; version?: string; detail?: string };
  options: Array<{ id: string; label: string; type: 'boolean' | 'string'; description?: string; value: unknown }>;
}

interface Data {
  context: string;
  env: { local?: string; ingressClass?: string };
  helm: boolean;
  addons: AddonView[];
}

const app = $('app');
const titleEl = el('h1', { text: 'Add-ons' });
const body = el('div');
const busy = new Set<string>();
let data: Data | undefined;

const chartButton = el('button', { className: 'btn', type: 'button', title: 'Search Artifact Hub and install any chart' }, icon('search'), 'Install Any Helm Chart…');
chartButton.addEventListener('click', () => void request('installChart'));
clear(app);
app.append(el('div', { className: 'toolbar' }, titleEl, el('span', { className: 'spacer' }), chartButton, iconButton('refresh', 'Refresh', () => void load())), body);

function optionValues(card: HTMLElement, addon: AddonView): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const option of addon.options) {
    const input = card.querySelector<HTMLInputElement>(`[data-option="${option.id}"]`);
    values[option.id] = option.type === 'boolean' ? !!input?.checked : input?.value ?? '';
  }
  return values;
}

function renderCard(addon: AddonView): HTMLElement {
  const s = addon.status;
  const card = el('div', { className: 'card' });
  const state = busy.has(addon.id) ? badge('working…', 'info') : s.installed ? badge(s.version ? `installed ${s.version}` : 'installed', s.detail ? 'warn' : 'ok') : badge('not installed', 'muted');
  card.append(el('div', { className: 'card-title' }, el('span', { text: addon.title }), state, el('span', { className: 'spacer' }), iconButton('details', 'Documentation', () => void request('docs', { url: addon.docs }))));
  card.append(el('div', { text: addon.description }));
  card.append(el('div', { className: 'source', text: `${addon.source}${addon.namespace ? ` → ${addon.namespace}` : ''}` }));
  if (s.detail) {
    card.append(el('div', { className: 'tone-text-warn', text: s.detail }));
  }
  if (!s.installed || s.managed) {
    for (const option of addon.options) {
      if (option.type === 'boolean') {
        const box = el('input', { type: 'checkbox', checked: !!option.value });
        box.dataset.option = option.id;
        card.append(el('label', { className: 'option-row' }, el('span', {}, box, ' ', option.label), option.description ? el('span', { className: 'hint', text: option.description }) : null));
      } else {
        const input = el('input', { type: 'text', value: String(option.value ?? ''), placeholder: option.description ?? '' });
        input.dataset.option = option.id;
        card.append(el('label', { className: 'option-row' }, el('span', { text: option.label }), input));
      }
    }
  }
  const actions = el('div', { className: 'card-actions' });
  const button = (label: string, iconName: string, primary: boolean, run: () => Promise<unknown>, danger = false): void => {
    const b = el('button', { className: `btn${primary ? ' primary' : ''}${danger ? ' danger' : ''}`, type: 'button', disabled: busy.has(addon.id) }, icon(iconName), label);
    b.addEventListener('click', async () => {
      busy.add(addon.id);
      render();
      try {
        await run();
      } finally {
        busy.delete(addon.id);
        await load();
      }
    });
    actions.append(b);
  };
  if (addon.needsHelm && !data?.helm) {
    actions.append(el('span', { className: 'muted', text: 'Needs the Helm CLI — you will be offered to install it.' }));
  }
  if (!s.installed) {
    button('Install', 'download', true, () => request('install', { id: addon.id, options: optionValues(card, addon) }));
    if (addon.needsHelm) {
      button('Edit Values & Install…', 'edit', false, () => request('editValues', { id: addon.id, options: optionValues(card, addon) }));
    }
  } else if (s.managed) {
    button('Upgrade / Reconfigure', 'restart', false, () => request('install', { id: addon.id, options: optionValues(card, addon) }));
    button('Uninstall', 'delete', false, () => request('uninstall', { id: addon.id }), true);
  } else {
    actions.append(el('span', { className: 'muted', text: 'Installed outside this catalog; manage it where it was installed.' }));
  }
  card.append(actions);
  return card;
}

function render(): void {
  clear(body);
  if (!data) {
    body.append(el('div', { className: 'loading' }, el('span', { className: 'spinner' }), 'Checking what is installed…'));
    return;
  }
  titleEl.textContent = `Add-ons · ${data.context}`;
  if (data.env.local) {
    body.append(notice(`Local ${data.env.local} cluster detected: options are preset for it (e.g. kubelet TLS for metrics-server${data.env.local === 'kind' ? ', host ports for ingress-nginx' : ''}).`));
  }
  const categories = [...new Set(data.addons.map((a) => a.category))];
  for (const category of categories) {
    body.append(el('div', { className: 'section' }, el('h2', { text: category })));
    const grid = el('div', { className: 'catalog' });
    for (const addon of data.addons.filter((a) => a.category === category)) {
      grid.append(renderCard(addon));
    }
    body.append(grid);
  }
}

async function load(): Promise<void> {
  try {
    data = await request<Data>('load');
    render();
  } catch (err) {
    clear(body);
    body.append(errorBox((err as Error).message));
  }
}

render();
initMeta();
void load();
