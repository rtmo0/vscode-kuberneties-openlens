import { $, clear, debounce, el, getState, icon, iconButton, initMeta, on, request, setState } from '../shared/client';

interface LogLine {
  s: number;
  t?: string;
  m: string;
}

type Level = 'error' | 'warn' | 'info' | 'debug' | '';

interface UiState {
  search: string;
  onlyMatches: boolean;
  level: '' | 'warn' | 'error';
  timestamps: boolean;
  wrap: boolean;
  json: boolean;
  follow: boolean;
}

const MAX_LINES = 20000;

let ui = getState<UiState>({ search: '', onlyMatches: false, level: '', timestamps: false, wrap: true, json: true, follow: true });
let lines: LogLine[] = [];
let sources: string[] = [];
const disabled = new Set<number>();
let streaming = true;
let previous = false;
let matchIndex = -1;

const app = $('app');
document.body.classList.add('page-logs');

const titleEl = el('h1');
const searchInput = el('input', { type: 'search', placeholder: 'Search (Enter: next, Shift+Enter: previous)', value: ui.search });
const matchCount = el('span', { className: 'muted' });
const levelSelect = el('select', { title: 'Level' });
levelSelect.append(el('option', { value: '', text: 'All levels' }), el('option', { value: 'warn', text: 'Warnings and errors' }), el('option', { value: 'error', text: 'Errors only' }));
levelSelect.value = ui.level;
const sinceSelect = el('select', { title: 'Since' });
for (const [value, label] of [['', 'Tail'], ['300', 'Last 5 min'], ['900', 'Last 15 min'], ['3600', 'Last hour'], ['21600', 'Last 6 hours'], ['86400', 'Last 24 hours'], ['all', 'All']]) {
  sinceSelect.append(el('option', { value, text: label }));
}
const pauseButton = el('button', { className: 'btn', type: 'button' });
const view = el('div', { className: 'log-view' });
const sourcesBar = el('div', { className: 'log-sources' });
const status = el('div', { className: 'log-status' });

function toggle(label: string, key: 'onlyMatches' | 'timestamps' | 'wrap' | 'json' | 'follow', title: string): HTMLElement {
  const box = el('input', { type: 'checkbox', checked: ui[key] });
  box.addEventListener('change', () => {
    ui[key] = box.checked;
    save();
    if (key === 'follow' && box.checked) {
      scrollToEnd();
    } else {
      renderAll();
    }
  });
  return el('label', { className: 'toggle', title }, box, label);
}

function save(): void {
  setState(ui);
}

function build(): void {
  const previousBox = el('input', { type: 'checkbox' });
  previousBox.addEventListener('change', () => {
    previous = previousBox.checked;
    void request('restart', { previous });
  });
  const toolbar = el(
    'div',
    { className: 'toolbar' },
    titleEl,
    el('span', { className: 'spacer' }),
    el('label', { className: 'search' }, icon('search'), searchInput),
    matchCount,
    toggle('Only matches', 'onlyMatches', 'Hide lines that do not match the search'),
    levelSelect,
    sinceSelect,
    el('label', { className: 'toggle', title: 'Logs of the previous container instance' }, previousBox, 'Previous'),
    toggle('Time', 'timestamps', 'Show timestamps'),
    toggle('Wrap', 'wrap', 'Wrap long lines'),
    toggle('JSON', 'json', 'Format JSON log lines'),
    toggle('Follow', 'follow', 'Keep scrolled to the newest line'),
    pauseButton,
    iconButton('delete', 'Clear', () => {
      lines = [];
      renderAll();
    }),
    iconButton('download', 'Save to file', () => void request('download', { text: visibleText() })),
    iconButton('copy', 'Copy visible lines', () => void request('copy', { text: visibleText() }))
  );
  clear(app);
  app.append(el('div', { className: 'logs-app' }, el('div', { className: 'protected-banner', text: '⚠ Protected context' }), toolbar, sourcesBar, view, status));
  updatePause();
}

function updatePause(): void {
  clear(pauseButton);
  pauseButton.append(icon(streaming ? 'pause' : 'play'), streaming ? 'Pause' : previous ? 'Reload' : 'Resume');
  pauseButton.disabled = false;
}

pauseButton.addEventListener('click', () => {
  if (streaming) {
    void request('pause');
    streaming = false;
  } else {
    void request(previous ? 'restart' : 'resume', previous ? { previous } : undefined);
    streaming = true;
  }
  updatePause();
  renderStatus();
});

// ─────────────────────────── parsing ───────────────────────────

interface Parsed {
  level: Level;
  json?: Record<string, unknown>;
}

const parsedCache = new WeakMap<LogLine, Parsed>();

function parse(line: LogLine): Parsed {
  let parsed = parsedCache.get(line);
  if (parsed) {
    return parsed;
  }
  let json: Record<string, unknown> | undefined;
  const text = line.m.trim();
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const value = JSON.parse(text);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        json = value as Record<string, unknown>;
      }
    } catch {
      // not JSON
    }
  }
  const levelText = String(json?.level ?? json?.lvl ?? json?.severity ?? (json?.log as Record<string, unknown> | undefined)?.level ?? json?.['log.level'] ?? '');
  parsed = { level: detectLevel(levelText || line.m), json };
  parsedCache.set(line, parsed);
  return parsed;
}

function detectLevel(text: string): Level {
  if (/\b(error|err|fatal|panic|crit(ical)?|emerg(ency)?|alert)\b|^E\d{4} /i.test(text)) {
    return 'error';
  }
  if (/\bwarn(ing)?\b|^W\d{4} /i.test(text)) {
    return 'warn';
  }
  if (/\b(debug|trace)\b/i.test(text)) {
    return 'debug';
  }
  if (/\binfo\b|^I\d{4} /i.test(text)) {
    return 'info';
  }
  return '';
}

function displayText(line: LogLine): string {
  const { json } = parse(line);
  if (!ui.json || !json) {
    return line.m;
  }
  const message = json.msg ?? json.message ?? json.MESSAGE ?? '';
  const skip = new Set(['msg', 'message', 'MESSAGE', 'level', 'lvl', 'severity', 'time', 'ts', 'timestamp', '@timestamp']);
  const rest = Object.entries(json)
    .filter(([key]) => !skip.has(key))
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
  const level = String(json.level ?? json.lvl ?? json.severity ?? '');
  return [level ? level.toUpperCase() : '', String(message), ...rest].filter(Boolean).join('  ');
}

function matchesSearch(text: string): boolean {
  return !ui.search || text.toLowerCase().includes(ui.search.toLowerCase());
}

function visible(line: LogLine): boolean {
  if (disabled.has(line.s)) {
    return false;
  }
  const level = parse(line).level;
  if (ui.level === 'error' && level !== 'error') {
    return false;
  }
  if (ui.level === 'warn' && level !== 'error' && level !== 'warn') {
    return false;
  }
  return !(ui.onlyMatches && ui.search && !matchesSearch(displayText(line)));
}

// ─────────────────────────── rendering ───────────────────────────

function formatTime(ts: string): string {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? ts : `${date.toLocaleTimeString(undefined, { hour12: false })}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

function highlight(target: HTMLElement, text: string): void {
  if (!ui.search) {
    target.textContent = text;
    return;
  }
  const needle = ui.search.toLowerCase();
  const lower = text.toLowerCase();
  let index = 0;
  for (;;) {
    const found = lower.indexOf(needle, index);
    if (found < 0) {
      target.append(text.slice(index));
      return;
    }
    target.append(text.slice(index, found), el('mark', { text: text.slice(found, found + needle.length) }));
    index = found + needle.length;
  }
}

function renderLine(line: LogLine): HTMLElement {
  const level = parse(line).level;
  const row = el('div', { className: `log-line${level ? ` level-${level}` : ''}` });
  if (sources.length > 1) {
    row.append(el('span', { className: `src src-${line.s % 6}`, text: sources[line.s] ?? '' }));
  }
  if (ui.timestamps && line.t) {
    row.append(el('span', { className: 'ts', text: formatTime(line.t), title: line.t }));
  }
  const msg = el('span', { className: 'msg' });
  highlight(msg, displayText(line));
  row.append(msg);
  return row;
}

function renderAll(): void {
  view.classList.toggle('wrap', ui.wrap);
  const fragment = document.createDocumentFragment();
  for (const line of lines) {
    if (visible(line)) {
      fragment.append(renderLine(line));
    }
  }
  clear(view);
  view.append(fragment);
  matchIndex = -1;
  renderStatus();
  if (ui.follow) {
    scrollToEnd();
  }
}

function append(batch: LogLine[]): void {
  const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
  lines.push(...batch);
  if (lines.length > MAX_LINES) {
    lines = lines.slice(lines.length - MAX_LINES);
    renderAll();
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const line of batch) {
    if (visible(line)) {
      fragment.append(renderLine(line));
    }
  }
  view.append(fragment);
  renderStatus();
  if (ui.follow && atBottom) {
    scrollToEnd();
  }
}

function scrollToEnd(): void {
  view.scrollTop = view.scrollHeight;
}

function renderStatus(): void {
  const shown = view.childElementCount;
  const marks = view.querySelectorAll('mark').length;
  matchCount.textContent = ui.search ? `${marks} match${marks === 1 ? '' : 'es'}` : '';
  clear(status);
  status.append(
    el('span', { text: `${lines.length} lines${shown !== lines.length ? `, ${shown} shown` : ''}${lines.length >= MAX_LINES ? ` (last ${MAX_LINES} kept)` : ''}` }),
    el('span', { text: streaming ? (previous ? 'Loading previous instance' : '● Streaming') : previous ? 'Previous instance' : '❚❚ Paused' })
  );
}

function renderSources(): void {
  clear(sourcesBar);
  if (sources.length <= 1) {
    sourcesBar.style.display = 'none';
    return;
  }
  sourcesBar.style.display = '';
  sources.forEach((name, index) => {
    const chip = el('span', { className: `log-source src-${index % 6}${disabled.has(index) ? ' off' : ''}`, text: `● ${name}`, title: 'Click to show / hide this source' });
    chip.addEventListener('click', () => {
      if (disabled.has(index)) {
        disabled.delete(index);
      } else {
        disabled.add(index);
      }
      renderSources();
      renderAll();
    });
    sourcesBar.append(chip);
  });
}

function visibleText(): string {
  return lines
    .filter(visible)
    .map((line) => [sources.length > 1 ? `[${sources[line.s]}]` : '', line.t ?? '', line.m].filter(Boolean).join(' '))
    .join('\n');
}

function jumpToMatch(delta: number): void {
  const marks = Array.from(view.querySelectorAll('mark'));
  if (!marks.length) {
    return;
  }
  marks[matchIndex]?.classList.remove('current');
  matchIndex = (matchIndex + delta + marks.length) % marks.length;
  const mark = marks[matchIndex];
  mark.classList.add('current');
  mark.scrollIntoView({ block: 'center' });
  ui.follow = false;
  matchCount.textContent = `${matchIndex + 1} of ${marks.length}`;
}

searchInput.addEventListener(
  'input',
  debounce(() => {
    ui.search = searchInput.value;
    save();
    renderAll();
  }, 200)
);
searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    jumpToMatch(event.shiftKey ? -1 : 1);
  }
});
levelSelect.addEventListener('change', () => {
  ui.level = levelSelect.value as UiState['level'];
  save();
  renderAll();
});
sinceSelect.addEventListener('change', () => {
  const value = sinceSelect.value;
  streaming = true;
  updatePause();
  void request('restart', value === 'all' ? { tailLines: 0 } : value ? { sinceSeconds: Number(value) } : {});
});
view.addEventListener('scroll', () => {
  const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
  if (!atBottom && ui.follow && streaming) {
    // Scrolling up pauses auto-follow until the user scrolls back down.
    view.dataset.held = 'true';
  } else if (atBottom) {
    delete view.dataset.held;
  }
});
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'f') {
    event.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});

on<LogLine[]>('lines', (batch) => append(batch));
on('reset', () => {
  lines = [];
  renderAll();
});
on<{ streaming: boolean }>('state', (state) => {
  streaming = state.streaming;
  updatePause();
  renderStatus();
});

async function start(): Promise<void> {
  build();
  initMeta();
  const init = await request<{ title: string; sources: string[]; previous: boolean }>('init');
  titleEl.textContent = init.title;
  sources = init.sources;
  previous = init.previous;
  renderSources();
  renderAll();
}

void start();
