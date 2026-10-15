import { $, clear, el, errorBox, icon, iconButton, initMeta, request } from '../shared/client';

interface Check {
  id: string;
  group: string;
  title: string;
  status: 'ok' | 'warn' | 'error' | 'info';
  detail: string;
  items?: string[];
  fixes?: Array<{ label: string; action: string; arg?: string }>;
}

interface Result {
  context: string;
  checks?: Check[];
  error?: string;
  at?: string;
}

const ICONS: Record<Check['status'], { text: string; tone: string }> = {
  ok: { text: '✔', tone: 'tone-ok' },
  warn: { text: '⚠', tone: 'tone-warn' },
  error: { text: '✖', tone: 'tone-error' },
  info: { text: 'ℹ', tone: 'tone-info' }
};

const app = $('app');
const titleEl = el('h1', { text: 'Cluster Doctor' });
const body = el('div');
const outputs = new Map<string, string>();
let result: Result | undefined;
let running = false;

clear(app);
app.append(el('div', { className: 'toolbar' }, titleEl, el('span', { className: 'spacer' }), iconButton('refresh', 'Run the checks again', () => void run())), body);

function render(): void {
  clear(body);
  if (running && !result) {
    body.append(el('div', { className: 'loading' }, el('span', { className: 'spinner' }), 'Examining the cluster…'));
    return;
  }
  if (!result) {
    return;
  }
  titleEl.textContent = `Cluster Doctor · ${result.context}`;
  if (result.error) {
    body.append(errorBox(result.error));
    return;
  }
  const checks = result.checks ?? [];
  const count = (s: Check['status']): number => checks.filter((c) => c.status === s).length;
  body.append(
    el(
      'div',
      { className: 'summary' },
      el('span', { className: 'tone-ok', text: `✔ ${count('ok')} passed` }),
      el('span', { className: 'tone-warn', text: `⚠ ${count('warn')} warnings` }),
      el('span', { className: 'tone-error', text: `✖ ${count('error')} problems` }),
      el('span', { className: 'muted', text: running ? 'checking…' : `checked ${new Date(result.at ?? '').toLocaleTimeString()}` })
    )
  );
  for (const group of [...new Set(checks.map((c) => c.group))]) {
    const section = el('section', { className: 'section' }, el('h2', { text: group }));
    for (const check of checks.filter((c) => c.group === group)) {
      const row = el('div', { className: 'doctor-check' });
      row.append(el('span', { className: `status-icon ${ICONS[check.status].tone}`, text: ICONS[check.status].text }));
      const content = el('div', {}, el('div', { className: 'title', text: check.title }), el('div', { text: check.detail }));
      if (check.items?.length) {
        content.append(el('ul', {}, ...check.items.map((item) => el('li', { text: item }))));
      }
      if (check.fixes?.length) {
        const fixes = el('div', { className: 'fixes' });
        for (const fix of check.fixes) {
          const b = el('button', { className: `btn${check.status === 'ok' || check.status === 'info' ? '' : ' primary'}`, type: 'button' }, icon(fix.action === 'openDocs' ? 'details' : fix.action === 'openTable' ? 'search' : 'play'), fix.label);
          b.addEventListener('click', async () => {
            b.disabled = true;
            const response = await request<{ changed: boolean; output?: string }>('fix', fix).catch(() => ({ changed: false, output: undefined }));
            if (response.output) {
              outputs.set(check.id, response.output);
            }
            if (response.changed) {
              await run();
            } else {
              b.disabled = false;
              render();
            }
          });
          fixes.append(b);
        }
        content.append(fixes);
      }
      const output = outputs.get(check.id);
      if (output) {
        content.append(el('pre', { className: 'code', text: output }));
      }
      row.append(content);
      section.append(row);
    }
    body.append(section);
  }
}

async function run(): Promise<void> {
  running = true;
  render();
  result = await request<Result>('run').catch((err) => ({ context: '', error: (err as Error).message }));
  running = false;
  render();
}

initMeta();
void run();
