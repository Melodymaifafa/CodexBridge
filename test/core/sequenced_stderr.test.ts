import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  classifyNetworkError,
  createSequencedStderrWriter,
} from '../../src/core/sequenced_stderr.js';

const START = '2026-10-16T02:00:00.000Z';

function createTestWriter() {
  let currentMs = Date.parse(START);
  const lines: string[] = [];
  const writer = createSequencedStderrWriter({
    now: () => new Date(currentMs),
    write: (text) => {
      lines.push(...text.split('\n').filter(Boolean));
    },
  });
  return {
    writer,
    lines,
    advance(ms: number) {
      currentMs += ms;
    },
  };
}

function networkError(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

function dnsError() {
  return networkError('getaddrinfo ENOTFOUND ilinkai.weixin.qq.com', 'ENOTFOUND');
}

test('writeLine prefixes every line with an ISO timestamp and a sequence number', () => {
  const { writer, lines, advance } = createTestWriter();

  writer.writeLine('[weixin-runtime] poll_start {}\n  second line  ');
  advance(1_500);
  writer.writeLine('[weixin-runtime] poll_end {}');

  assert.deepEqual(lines, [
    '2026-10-16T02:00:00.000Z [1] [weixin-runtime] poll_start {}',
    '2026-10-16T02:00:00.000Z [2] second line',
    '2026-10-16T02:00:01.500Z [3] [weixin-runtime] poll_end {}',
  ]);
});

test('each known network error is written as one line without a stack trace', () => {
  const cases = [
    { error: dnsError(), kind: 'ENOTFOUND', summary: 'Error: getaddrinfo ENOTFOUND ilinkai.weixin.qq.com' },
    { error: networkError('HTTPS request timed out after 20000ms', 'ETIMEDOUT'), kind: 'TIMEOUT', summary: 'Error: HTTPS request timed out after 20000ms' },
    { error: networkError('read ECONNRESET', 'ECONNRESET'), kind: 'ECONNRESET', summary: 'Error: read ECONNRESET' },
    {
      error: networkError('Client network socket disconnected before secure TLS connection was established', 'ECONNRESET'),
      kind: 'TLS_DISCONNECTED',
      summary: 'Error: Client network socket disconnected before secure TLS connection was established',
    },
    {
      error: networkError('self-signed certificate in certificate chain', 'SELF_SIGNED_CERT_IN_CHAIN'),
      kind: 'SELF_SIGNED_CERT',
      summary: 'Error: self-signed certificate in certificate chain',
    },
    { error: networkError('write EPIPE', 'EPIPE'), kind: 'EPIPE', summary: 'Error: write EPIPE' },
  ];

  for (const { error, kind, summary } of cases) {
    assert.match(String(error.stack), /\n\s+at /u);
    assert.equal(classifyNetworkError(error), kind);

    const { writer, lines } = createTestWriter();
    writer.writeError('[weixin]', error);
    writer.flush();

    assert.deepEqual(lines, [`${START} [1] [weixin] network ${kind}: ${summary}`]);
  }
});

test('network errors are recognised by message when the error code is missing', () => {
  assert.equal(classifyNetworkError(new Error('getaddrinfo ENOTFOUND ilinkai.weixin.qq.com')), 'ENOTFOUND');
  assert.equal(classifyNetworkError('Error: write EPIPE'), 'EPIPE');
  assert.equal(classifyNetworkError(new Error('Codex turn failed')), null);
});

test('consecutive identical network errors merge into one line with the count', () => {
  const { writer, lines, advance } = createTestWriter();

  for (let index = 0; index < 12; index += 1) {
    writer.writeError('[weixin]', dnsError());
    advance(2_000);
  }
  assert.deepEqual(lines, []);

  writer.writeLine('[weixin-runtime] process_inbound_event_start {}');

  assert.deepEqual(lines, [
    `${START} [1] [weixin] network ENOTFOUND: Error: getaddrinfo ENOTFOUND ilinkai.weixin.qq.com (x12 until 2026-10-16T02:00:22.000Z)`,
    '2026-10-16T02:00:24.000Z [2] [weixin-runtime] process_inbound_event_start {}',
  ]);
});

test('a different network error type starts a new line', () => {
  const { writer, lines, advance } = createTestWriter();

  writer.writeError('[weixin]', dnsError());
  advance(1_000);
  writer.writeError('[weixin]', dnsError());
  advance(1_000);
  writer.writeError('[weixin]', networkError('read ECONNRESET', 'ECONNRESET'));
  writer.flush();

  assert.deepEqual(lines, [
    `${START} [1] [weixin] network ENOTFOUND: Error: getaddrinfo ENOTFOUND ilinkai.weixin.qq.com (x2 until 2026-10-16T02:00:01.000Z)`,
    '2026-10-16T02:00:02.000Z [2] [weixin] network ECONNRESET: Error: read ECONNRESET',
  ]);
});

test('the same network error keeps merging while each repeat comes within 60 seconds of the last one', () => {
  const { writer, lines, advance } = createTestWriter();

  writer.writeError('[weixin]', dnsError());
  advance(50_000);
  writer.writeError('[weixin]', dnsError());
  advance(50_000);
  writer.writeError('[weixin]', dnsError());
  writer.flush();

  assert.deepEqual(lines, [
    `${START} [1] [weixin] network ENOTFOUND: Error: getaddrinfo ENOTFOUND ilinkai.weixin.qq.com (x3 until 2026-10-16T02:01:40.000Z)`,
  ]);
});

test('the same network error starts a new line after 60 seconds without a repeat', () => {
  const { writer, lines, advance } = createTestWriter();

  writer.writeError('[weixin]', dnsError());
  advance(59_999);
  writer.writeError('[weixin]', dnsError());
  advance(60_000);
  writer.writeError('[weixin]', dnsError());
  writer.flush();

  assert.deepEqual(lines, [
    `${START} [1] [weixin] network ENOTFOUND: Error: getaddrinfo ENOTFOUND ilinkai.weixin.qq.com (x2 until 2026-10-16T02:00:59.999Z)`,
    '2026-10-16T02:01:59.999Z [2] [weixin] network ENOTFOUND: Error: getaddrinfo ENOTFOUND ilinkai.weixin.qq.com',
  ]);
});

test('a pending network error line is written 60 seconds after its last repeat even if nothing else is logged', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { writer, lines, advance } = createTestWriter();

  writer.writeError('[weixin]', dnsError());
  advance(50_000);
  t.mock.timers.tick(50_000);
  writer.writeError('[weixin]', dnsError());
  t.mock.timers.tick(59_999);
  assert.deepEqual(lines, []);

  t.mock.timers.tick(1);

  assert.deepEqual(lines, [
    `${START} [1] [weixin] network ENOTFOUND: Error: getaddrinfo ENOTFOUND ilinkai.weixin.qq.com (x2 until 2026-10-16T02:00:50.000Z)`,
  ]);
});

test('a network error line still pending when the process exits is written on exit', () => {
  const { writer, lines, advance } = createTestWriter();
  const target = new EventEmitter();

  writer.flushOnExit(target);
  writer.writeError('[weixin]', dnsError());
  // Shutdown flushes first; an in-flight request then fails while the bridge stops.
  writer.flush();
  advance(1_000);
  writer.writeError('[weixin]', networkError('read ECONNRESET', 'ECONNRESET'));
  assert.equal(lines.length, 1);

  target.emit('exit', 0);

  assert.deepEqual(lines, [
    `${START} [1] [weixin] network ENOTFOUND: Error: getaddrinfo ENOTFOUND ilinkai.weixin.qq.com`,
    '2026-10-16T02:00:01.000Z [2] [weixin] network ECONNRESET: Error: read ECONNRESET',
  ]);
});

test('non-network errors keep their stack trace and end a pending network error line', () => {
  const { writer, lines, advance } = createTestWriter();
  const error = new Error('Codex turn failed');
  error.stack = 'Error: Codex turn failed\n    at runTurn (bridge.ts:10:5)\n    at poll (runtime.ts:20:3)';

  assert.equal(classifyNetworkError(error), null);
  writer.writeError('[weixin]', dnsError());
  advance(3_000);
  writer.writeError('[weixin]', error);

  assert.deepEqual(lines, [
    `${START} [1] [weixin] network ENOTFOUND: Error: getaddrinfo ENOTFOUND ilinkai.weixin.qq.com`,
    '2026-10-16T02:00:03.000Z [2] [weixin] Error: Codex turn failed',
    '2026-10-16T02:00:03.000Z [3]     at runTurn (bridge.ts:10:5)',
    '2026-10-16T02:00:03.000Z [4]     at poll (runtime.ts:20:3)',
  ]);
});

test('captured process warnings replace the default output with timestamped lines, keeping the stack except for deprecations', () => {
  const { writer, lines } = createTestWriter();
  const target = new EventEmitter();
  let defaultOutputCalls = 0;
  target.on('warning', () => {
    defaultOutputCalls += 1;
  });
  const warning = new Error('Possible EventEmitter memory leak detected. 11 approval_request listeners added to [CodexAppClient].');
  warning.name = 'MaxListenersExceededWarning';
  warning.stack = `${warning.name}: ${warning.message}\n    at _addListener (node:events:1:1)`;

  const deprecation = Object.assign(new Error('`module.register()` is deprecated.'), {
    name: 'DeprecationWarning',
    code: 'DEP0205',
  });

  writer.captureProcessWarnings(target, { execArgv: [], nodeOptions: '' });
  target.emit('warning', warning);
  target.emit('warning', deprecation);

  assert.equal(defaultOutputCalls, 0);
  assert.deepEqual(lines, [
    `${START} [1] (node:${process.pid}) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 approval_request listeners added to [CodexAppClient].`,
    `${START} [2]     at _addListener (node:events:1:1)`,
    `${START} [3] (node:${process.pid}) [DEP0205] DeprecationWarning: \`module.register()\` is deprecated.`,
  ]);
});

test('process warnings stay with Node when --redirect-warnings sends them to a file', () => {
  const redirects = [
    { execArgv: ['--redirect-warnings=/var/log/bridge-warnings.log'], nodeOptions: '' },
    { execArgv: ['--redirect-warnings', 'warnings.log'], nodeOptions: '' },
    { execArgv: [], nodeOptions: '--max-old-space-size=512 --redirect-warnings="bridge warnings.log"' },
    { execArgv: [], nodeOptions: '--redirect_warnings=warnings.log' },
  ];

  for (const options of redirects) {
    const { writer, lines } = createTestWriter();
    const target = new EventEmitter();
    let defaultOutputCalls = 0;
    target.on('warning', () => {
      defaultOutputCalls += 1;
    });

    writer.captureProcessWarnings(target, options);
    target.emit('warning', Object.assign(new Error('leak'), { name: 'MaxListenersExceededWarning' }));

    assert.equal(defaultOutputCalls, 1, JSON.stringify(options));
    assert.deepEqual(lines, []);
  }

  // An empty value is no redirect: Node then prints to stderr, so the warning is captured.
  const { writer, lines } = createTestWriter();
  const target = new EventEmitter();
  let defaultOutputCalls = 0;
  target.on('warning', () => {
    defaultOutputCalls += 1;
  });
  writer.captureProcessWarnings(target, { execArgv: ['--redirect-warnings='], nodeOptions: '' });
  target.emit('warning', Object.assign(new Error('leak'), { name: 'MaxListenersExceededWarning' }));
  assert.equal(defaultOutputCalls, 0);
  assert.equal(lines[0], `${START} [1] (node:${process.pid}) MaxListenersExceededWarning: leak`);
});
