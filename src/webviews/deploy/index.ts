import { $, clear, debounce, el, getState, icon, initMeta, request, setState } from '../shared/client';

interface Init {
  context: string;
  namespace: string;
  namespaces: string[];
  ingressClasses: string[];
  defaultIngressClass?: string;
  issuers: string[];
  metrics: boolean;
}

interface Form {
  name: string;
  namespace: string;
  image: string;
  port?: number;
  replicas: number;
  env: string;
  envFromSecret?: string;
  envFromConfigMap?: string;
  imagePullSecret?: string;
  resources: 'none' | 'small' | 'medium' | 'large';
  healthPath?: string;
  expose: 'none' | 'ClusterIP' | 'NodePort' | 'LoadBalancer';
  host?: string;
  path?: string;
  ingressClass?: string;
  tlsIssuer?: string;
  hpa: boolean;
  hpaMin: number;
  hpaMax: number;
  hpaCpu: number;
}

const app = $('app');
const saved = getState<{ form?: Partial<Form> }>({});
let init: Init | undefined;

const fields: Record<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement> = {};
const preview = el('pre', { className: 'code' });
const errors = el('div', { className: 'errors' });
const status = el('span', { className: 'muted' });

function input(id: string, type: 'text' | 'number' = 'text', placeholder = ''): HTMLInputElement {
  const node = el('input', { type, placeholder });
  fields[id] = node;
  node.addEventListener('input', refresh);
  return node;
}

function select(id: string, options: Array<[string, string]>): HTMLSelectElement {
  const node = el('select');
  for (const [value, label] of options) {
    node.append(el('option', { value, text: label }));
  }
  fields[id] = node;
  node.addEventListener('change', refresh);
  return node;
}

function checkbox(id: string): HTMLInputElement {
  const node = el('input', { type: 'checkbox' });
  fields[id] = node;
  node.addEventListener('change', refresh);
  return node;
}

function row(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return el('label', { className: 'form-row' }, el('span', { text: label }), control, hint ? el('span', { className: 'hint', text: hint }) : null);
}

function fieldset(title: string, ...rows: HTMLElement[]): HTMLElement {
  return el('div', { className: 'fieldset' }, el('h3', { text: title }), ...rows);
}

function value(id: string): string {
  return (fields[id]?.value ?? '').trim();
}

function form(): Form {
  const num = (id: string, fallback: number): number => (Number.isFinite(Number(value(id))) && value(id) ? Number(value(id)) : fallback);
  return {
    name: value('name'),
    namespace: value('namespace') || 'default',
    image: value('image'),
    port: value('port') ? Number(value('port')) : undefined,
    replicas: num('replicas', 1),
    env: (fields.env as HTMLTextAreaElement).value,
    envFromSecret: value('envFromSecret') || undefined,
    envFromConfigMap: value('envFromConfigMap') || undefined,
    imagePullSecret: value('imagePullSecret') || undefined,
    resources: value('resources') as Form['resources'],
    healthPath: value('healthPath') || undefined,
    expose: value('expose') as Form['expose'],
    host: value('host') || undefined,
    path: value('path') || '/',
    ingressClass: value('ingressClass') || undefined,
    tlsIssuer: value('tlsIssuer') || undefined,
    hpa: (fields.hpa as HTMLInputElement).checked,
    hpaMin: num('hpaMin', 2),
    hpaMax: num('hpaMax', 5),
    hpaCpu: num('hpaCpu', 70)
  };
}

const refresh = debounce(async () => {
  const f = form();
  setState({ form: f });
  const result = await request<{ errors: string[]; yaml: string }>('preview', f);
  clear(errors);
  for (const e of result.errors) {
    errors.append(el('div', { text: `• ${e}` }));
  }
  preview.textContent = result.yaml || '# Fill in the form';
}, 200);

function fillSelect(id: string, values: string[], empty: string): void {
  const node = fields[id] as HTMLSelectElement;
  const current = node.value;
  clear(node);
  node.append(el('option', { value: '', text: empty }));
  for (const v of values) {
    node.append(el('option', { value: v, text: v }));
  }
  node.value = values.includes(current) ? current : '';
}

async function loadNamespace(): Promise<void> {
  const data = await request<{ secrets: string[]; pullSecrets: string[]; configMaps: string[] }>('namespaceData', { namespace: value('namespace') || 'default' }).catch(() => ({ secrets: [], pullSecrets: [], configMaps: [] }));
  fillSelect('envFromSecret', data.secrets, 'None');
  fillSelect('envFromConfigMap', data.configMaps, 'None');
  fillSelect('imagePullSecret', data.pullSecrets, 'None (public image)');
}

function build(): void {
  const i = init!;
  const namespaceInput = input('namespace');
  namespaceInput.setAttribute('list', 'namespaces');
  namespaceInput.addEventListener('change', () => void loadNamespace());
  const datalist = el('datalist', { id: 'namespaces' }, ...i.namespaces.map((n) => el('option', { value: n })));
  const env = el('textarea', { placeholder: 'LOG_LEVEL=info\nFEATURE_X=true' });
  fields.env = env;
  env.addEventListener('input', refresh);

  const left = el(
    'div',
    {},
    fieldset(
      'Application',
      row('Name', input('name', 'text', 'my-app')),
      row('Namespace', namespaceInput, 'Created if it does not exist'),
      row('Image', input('image', 'text', 'nginx:1.27-alpine or ghcr.io/org/app:1.2.3')),
      row('Container port', input('port', 'number', '80')),
      row('Replicas', input('replicas', 'number'))
    ),
    fieldset(
      'Configuration',
      row('Environment', env, 'KEY=value, one per line'),
      row('Variables from Secret', select('envFromSecret', [['', 'None']])),
      row('Variables from ConfigMap', select('envFromConfigMap', [['', 'None']])),
      row('Image pull secret', select('imagePullSecret', [['', 'None (public image)']]), 'Create one with "New Image Pull Secret"'),
      row(
        'Resources',
        select('resources', [
          ['small', 'Small — 50m CPU, 64Mi (limit 128Mi)'],
          ['medium', 'Medium — 250m CPU, 256Mi (limit 512Mi)'],
          ['large', 'Large — 1 CPU, 1Gi (limit 2Gi)'],
          ['none', 'Not set']
        ])
      ),
      row('Health check path', input('healthPath', 'text', '/healthz'), 'HTTP readiness and liveness probes; empty uses a TCP check')
    ),
    fieldset(
      'Network',
      row(
        'Service',
        select('expose', [
          ['ClusterIP', 'ClusterIP — inside the cluster'],
          ['NodePort', 'NodePort — on every node'],
          ['LoadBalancer', 'LoadBalancer — cloud load balancer'],
          ['none', 'No service']
        ])
      ),
      row('Ingress host', input('host', 'text', 'app.example.com'), i.ingressClasses.length ? 'Leave empty for no Ingress' : 'No ingress controller in this cluster — install ingress-nginx from Add-ons'),
      row('Path', input('path', 'text', '/')),
      row('Ingress class', select('ingressClass', [['', i.defaultIngressClass ? `Default (${i.defaultIngressClass})` : 'Default'], ...i.ingressClasses.map((c) => [c, c] as [string, string])])),
      row('TLS certificate', select('tlsIssuer', [['', i.issuers.length ? 'No TLS' : 'No TLS (install cert-manager for certificates)'], ...i.issuers.map((c) => [c, `cert-manager: ${c}`] as [string, string])]))
    ),
    fieldset(
      'Autoscaling',
      row('Scale on CPU', checkbox('hpa'), i.metrics ? 'HorizontalPodAutoscaler between min and max replicas' : 'Needs metrics-server (Add-ons)'),
      row('Min / max replicas', el('span', { className: 'ratio' }, input('hpaMin', 'number'), input('hpaMax', 'number'))),
      row('Target CPU %', input('hpaCpu', 'number'))
    )
  );

  const applyButton = el('button', { className: 'btn primary', type: 'button' }, icon('play'), 'Deploy');
  applyButton.addEventListener('click', async () => {
    applyButton.disabled = true;
    status.textContent = 'Deploying…';
    const result = await request<{ ok: boolean; error?: string }>('apply', form()).catch((err) => ({ ok: false, error: (err as Error).message }));
    status.textContent = result.ok ? '✔ Deployed — opening the deployment' : result.error ? `✖ ${result.error}` : '';
    applyButton.disabled = false;
  });
  const editorButton = el('button', { className: 'btn', type: 'button' }, icon('edit'), 'Open in Editor');
  editorButton.addEventListener('click', () => void request('openEditor', form()));

  const right = el('div', {}, el('div', { className: 'card-actions' }, applyButton, editorButton, status), errors, preview);
  clear(app);
  app.append(el('div', { className: 'toolbar' }, el('h1', { text: `Deploy an Image · ${i.context}` })), datalist, el('div', { className: 'split' }, left, right));

  const defaults: Partial<Form> = { namespace: i.namespace, replicas: 2, resources: 'small', expose: 'ClusterIP', path: '/', hpaMin: 2, hpaMax: 5, hpaCpu: 70, ...saved.form };
  for (const [id, node] of Object.entries(fields)) {
    const v = (defaults as Record<string, unknown>)[id];
    if (v === undefined) {
      continue;
    }
    if (node instanceof HTMLInputElement && node.type === 'checkbox') {
      node.checked = !!v;
    } else {
      node.value = String(v);
    }
  }
  void loadNamespace().then(() => {
    for (const id of ['envFromSecret', 'envFromConfigMap', 'imagePullSecret']) {
      const v = (saved.form as Record<string, unknown> | undefined)?.[id];
      if (v) {
        fields[id].value = String(v);
      }
    }
    refresh();
  });
}

async function start(): Promise<void> {
  app.append(el('div', { className: 'loading' }, el('span', { className: 'spinner' }), 'Loading…'));
  init = await request<Init>('init');
  build();
  initMeta();
}

void start();
