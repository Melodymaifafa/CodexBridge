const NETWORK_ERROR_MERGE_WINDOW_MS = 60_000;

// Order matters: a dropped TLS handshake also carries code ECONNRESET.
const NETWORK_ERROR_KINDS = [
  { kind: 'ENOTFOUND', codes: ['ENOTFOUND'], pattern: /\bENOTFOUND\b/u },
  { kind: 'TLS_DISCONNECTED', codes: [], pattern: /socket disconnected before secure TLS connection/iu },
  { kind: 'ECONNRESET', codes: ['ECONNRESET'], pattern: /\bECONNRESET\b/u },
  { kind: 'TIMEOUT', codes: ['ETIMEDOUT'], pattern: /request timed out|\bETIMEDOUT\b/iu },
  {
    kind: 'SELF_SIGNED_CERT',
    codes: ['SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT'],
    pattern: /self[- ]signed certificate/iu,
  },
  { kind: 'EPIPE', codes: ['EPIPE'], pattern: /\bEPIPE\b/u },
] as const;

export type NetworkErrorKind = typeof NETWORK_ERROR_KINDS[number]['kind'];

type SequencedStderrOptions = {
  envVar?: string | null;
};

type SequencedStderrWriterOptions = {
  now?: () => Date;
  write?: (text: string) => void;
  mergeWindowMs?: number;
};

type NetworkErrorRun = {
  key: string;
  line: string;
  firstAt: Date;
  lastAt: Date;
  count: number;
  timer: ReturnType<typeof setTimeout>;
};

function shouldWrite(envVar: string | null | undefined): boolean {
  return !envVar || process.env[envVar] === '1';
}

export function classifyNetworkError(error: unknown): NetworkErrorKind | null {
  const code = typeof error === 'object' && error && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  const message = error instanceof Error ? error.message : String(error ?? '');
  const match = NETWORK_ERROR_KINDS.find((entry) => (
    (entry.codes as readonly string[]).includes(code) || entry.pattern.test(message)
  ));
  return match?.kind ?? null;
}

export function createSequencedStderrWriter({
  now = () => new Date(),
  write = (text) => {
    process.stderr.write(text);
  },
  mergeWindowMs = NETWORK_ERROR_MERGE_WINDOW_MS,
}: SequencedStderrWriterOptions = {}) {
  let sequence = 0;
  let pendingRun: NetworkErrorRun | null = null;

  const writeLines = (lines: string[], at: Date) => {
    for (const line of lines) {
      sequence += 1;
      write(`${at.toISOString()} [${sequence}] ${line}\n`);
    }
  };

  // A merged run is written once, when it ends: on any other line, a different
  // network error, 60s without a repeat, or an explicit flush.
  const flush = () => {
    if (!pendingRun) {
      return;
    }
    const run = pendingRun;
    pendingRun = null;
    clearTimeout(run.timer);
    const count = run.count > 1 ? ` (x${run.count} until ${run.lastAt.toISOString()})` : '';
    writeLines([`${run.line}${count}`], run.firstAt);
  };

  const scheduleFlush = () => {
    const timer = setTimeout(flush, mergeWindowMs);
    timer.unref?.();
    return timer;
  };

  const writeLine = (message: string) => {
    const lines = String(message ?? '')
      .trim()
      .split(/\r?\n/gu)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      return;
    }
    flush();
    writeLines(lines, now());
  };

  const writeError = (prefix: string, error: unknown) => {
    const at = now();
    const kind = classifyNetworkError(error);
    if (!kind) {
      flush();
      const text = error instanceof Error ? (error.stack || error.message) : String(error);
      const lines = `${prefix} ${text}`.split(/\r?\n/gu).map((line) => line.trimEnd()).filter(Boolean);
      writeLines(lines, at);
      return;
    }
    const key = `${prefix}\u0000${kind}`;
    if (pendingRun?.key === key && at.getTime() - pendingRun.lastAt.getTime() < mergeWindowMs) {
      pendingRun.count += 1;
      pendingRun.lastAt = at;
      clearTimeout(pendingRun.timer);
      pendingRun.timer = scheduleFlush();
      return;
    }
    flush();
    const summary = String(error).split(/\r?\n/u)[0];
    pendingRun = { key, line: `${prefix} network ${kind}: ${summary}`, firstAt: at, lastAt: at, count: 1, timer: scheduleFlush() };
  };

  // Replaces Node's default warning printer so warnings get the same timestamp.
  const captureProcessWarnings = (target: NodeJS.EventEmitter = process) => {
    const defaultListeners = target.listeners('warning');
    if (defaultListeners.length === 0) {
      return;
    }
    for (const listener of defaultListeners) {
      target.removeListener('warning', listener as (...args: unknown[]) => void);
    }
    target.on('warning', (warning: Error & { code?: string }) => {
      const prefix = warning.code ? `(node:${process.pid}) [${warning.code}]` : `(node:${process.pid})`;
      // Like Node's default output, deprecations stay on one line; other warnings keep their stack.
      if (warning.name === 'DeprecationWarning') {
        writeLine(`${prefix} ${warning.name}: ${warning.message}`);
        return;
      }
      writeError(prefix, warning);
    });
  };

  // The flush timer is unref'd, so a run that starts during shutdown (an
  // in-flight request failing while the bridge stops) is written on exit.
  const flushOnExit = (target: NodeJS.EventEmitter = process) => {
    target.once('exit', flush);
  };

  return { writeLine, writeError, flush, captureProcessWarnings, flushOnExit };
}

const stderrWriter = createSequencedStderrWriter();

export function writeSequencedStderrLine(
  message: string,
  {
    envVar = null,
  }: SequencedStderrOptions = {},
): void {
  if (!shouldWrite(envVar)) {
    return;
  }
  stderrWriter.writeLine(message);
}

export function writeSequencedStderrError(prefix: string, error: unknown): void {
  stderrWriter.writeError(prefix, error);
}

export function flushSequencedStderr(): void {
  stderrWriter.flush();
}

export function captureProcessWarningsInSequencedStderr(): void {
  stderrWriter.captureProcessWarnings();
}

export function flushSequencedStderrOnExit(): void {
  stderrWriter.flushOnExit();
}

export function writeSequencedDebugLog(
  tag: string,
  event: string,
  payload: unknown,
  {
    envVar = 'CODEXBRIDGE_DEBUG_WEIXIN',
  }: SequencedStderrOptions = {},
): void {
  if (!shouldWrite(envVar)) {
    return;
  }
  try {
    writeSequencedStderrLine(`[${tag}] ${event} ${JSON.stringify(payload)}`);
  } catch {
    writeSequencedStderrLine(`[${tag}] ${event}`);
  }
}
