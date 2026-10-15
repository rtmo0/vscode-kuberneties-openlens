/* Formatting helpers shared by the extension host and the webviews (no vscode imports). */

const BINARY_SUFFIXES: Record<string, number> = {
  Ki: 2 ** 10,
  Mi: 2 ** 20,
  Gi: 2 ** 30,
  Ti: 2 ** 40,
  Pi: 2 ** 50,
  Ei: 2 ** 60
};

const DECIMAL_SUFFIXES: Record<string, number> = {
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  '': 1,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18
};

/**
 * Parse a Kubernetes resource quantity ("250m", "1.5Gi", "129e6", "1200000n")
 * into its value in base units (cores for CPU, bytes for memory).
 */
export function parseQuantity(quantity: string | number | undefined | null): number {
  if (quantity === undefined || quantity === null || quantity === '') {
    return 0;
  }
  if (typeof quantity === 'number') {
    return quantity;
  }
  const match = /^([+-]?[0-9.]+(?:[eE][+-]?[0-9]+)?)([a-zA-Z]*)$/.exec(quantity.trim());
  if (!match) {
    return 0;
  }
  const value = Number(match[1]);
  const suffix = match[2];
  if (suffix in BINARY_SUFFIXES) {
    return value * BINARY_SUFFIXES[suffix];
  }
  if (suffix in DECIMAL_SUFFIXES) {
    return value * DECIMAL_SUFFIXES[suffix];
  }
  return value;
}

/** Format CPU cores like kubectl top: millicores below one core. */
export function formatCpu(cores: number): string {
  if (!Number.isFinite(cores) || cores <= 0) {
    return '0';
  }
  if (cores < 1) {
    return `${Math.max(1, Math.round(cores * 1000))}m`;
  }
  return cores >= 10 ? cores.toFixed(1) : cores.toFixed(2).replace(/\.?0+$/, '');
}

/** Format a byte count with binary units (Ki, Mi, Gi…). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0';
  }
  const units = ['B', 'Ki', 'Mi', 'Gi', 'Ti', 'Pi'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)}${units[unit]}`;
}

export function formatPercent(part: number, total: number): string {
  if (!total) {
    return '—';
  }
  return `${Math.round((part / total) * 100)}%`;
}

/** kubectl-style age: "12s", "5m", "3h12m", "4d6h", "2y40d". */
export function formatAge(timestamp: string | number | Date | undefined, now = Date.now()): string {
  if (!timestamp) {
    return '—';
  }
  const time = timestamp instanceof Date ? timestamp.getTime() : new Date(timestamp).getTime();
  if (!Number.isFinite(time)) {
    return '—';
  }
  let seconds = Math.max(0, Math.floor((now - time) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  let minutes = Math.floor(seconds / 60);
  seconds %= 60;
  if (minutes < 10) {
    return seconds ? `${minutes}m${seconds}s` : `${minutes}m`;
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  let hours = Math.floor(minutes / 60);
  minutes %= 60;
  if (hours < 8) {
    return minutes ? `${hours}h${minutes}m` : `${hours}h`;
  }
  if (hours < 24) {
    return `${hours}h`;
  }
  let days = Math.floor(hours / 24);
  hours %= 24;
  if (days < 8) {
    return hours ? `${days}d${hours}h` : `${days}d`;
  }
  if (days < 365) {
    return `${days}d`;
  }
  const years = Math.floor(days / 365);
  days %= 365;
  return days ? `${years}y${days}d` : `${years}y`;
}

export function pluralize(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}
