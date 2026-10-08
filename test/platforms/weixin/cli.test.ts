import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  acquireServeLock,
  codexLoginStateDir,
  createWeixinServeCodexAuthManager,
  enqueuePendingRestartNotification,
  flushPendingRestartNotifications,
  materializeQrArtifact,
  pendingRestartNotificationsFile,
  parseCodexCleanupInternalThreadsArgs,
  parseCodexNativeApiServeArgs,
  parseWeixinClearContextArgs,
  parseWeixinLoginArgs,
  parseWeixinServeArgs,
  readPendingRestartNotifications,
  resolveEmbeddedCodexNativeApiOptions,
  resolveClearContextAccountId,
  runWeixinSend,
} from '../../../src/cli.js';

const CHUNK_SEPARATOR = '\n---\n';

// Stands in for the Weixin plugin: splits on a separator the way the real one
// splits on the 2048-byte limit, honours skipDeliveryCount, and records every
// segment it actually puts on the wire so a test can prove none is sent twice.
function weixinSendTestPlugin({
  delivered,
  failOnDeliveryIndex = null,
  sendDelayMs = 0,
  clientIdSeeds = [],
  splitContent = (content: string) => content.split(CHUNK_SEPARATOR),
}: {
  delivered: string[];
  failOnDeliveryIndex?: number | null;
  sendDelayMs?: number;
  clientIdSeeds?: Array<string | undefined>;
  splitContent?: (content: string) => string[];
}) {
  const failedOnce = new Set<number>();
  return () => ({
    async start() {},
    async stop() {},
    planTextDeliveries(content: string) {
      return splitContent(content);
    },
    async sendText({ content, skipDeliveryCount = 0, clientIdSeed }: {
      externalScopeId: string;
      content: string;
      skipDeliveryCount?: number;
      clientIdSeed?: string;
    }) {
      clientIdSeeds.push(clientIdSeed);
      const chunks = splitContent(content);
      if (sendDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, sendDelayMs));
      }
      let deliveredCount = 0;
      for (let index = skipDeliveryCount; index < chunks.length; index += 1) {
        if (failOnDeliveryIndex === index && !failedOnce.has(index)) {
          failedOnce.add(index);
          return {
            success: false,
            deliveredCount,
            deliveredText: '',
            failedIndex: index,
            failedText: chunks[index],
            error: 'transport unavailable',
            errorCode: null,
            totalDeliveryCount: chunks.length,
          };
        }
        delivered.push(chunks[index]);
        deliveredCount += 1;
      }
      return {
        success: true,
        deliveredCount,
        deliveredText: content,
        failedIndex: null,
        failedText: '',
        error: '',
        errorCode: null,
        totalDeliveryCount: chunks.length,
      };
    },
  });
}

function weixinSendReceipts(stateDir: string) {
  const receiptsFile = path.join(stateDir, 'runtime', 'weixin-outbound-receipts.json');
  return JSON.parse(fs.readFileSync(receiptsFile, 'utf8'));
}

test('weixin send delivers a text file once for the same idempotency key', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-weixin-send-'));
  const digestPath = path.join(tmpDir, 'digest.md');
  const delivered: string[] = [];
  fs.writeFileSync(digestPath, '早报正文\n第二行', 'utf8');

  const args = [
    '--state-dir', tmpDir,
    '--to-user-id', 'melody@im.wechat',
    '--text-file', digestPath,
    '--idempotency-key', 'linear-digest-2026-07-31',
  ];
  const dependencies = {
    createPlatformPlugin: weixinSendTestPlugin({ delivered }),
  };

  await runWeixinSend(args, dependencies);
  await runWeixinSend(args, dependencies);

  assert.deepEqual(delivered, ['早报正文\n第二行']);
  assert.equal(weixinSendReceipts(tmpDir)['melody@im.wechat:linear-digest-2026-07-31'].status, 'sent');
});

test('weixin send keeps two concurrent runs with one idempotency key down to a single delivery', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-weixin-send-race-'));
  const digestPath = path.join(tmpDir, 'digest.md');
  const delivered: string[] = [];
  fs.writeFileSync(digestPath, '早报正文', 'utf8');

  const args = [
    '--state-dir', tmpDir,
    '--to-user-id', 'melody@im.wechat',
    '--text-file', digestPath,
    '--idempotency-key', 'linear-digest-2026-10-08',
  ];
  const dependencies = {
    createPlatformPlugin: weixinSendTestPlugin({ delivered, sendDelayMs: 60 }),
  };

  await Promise.all([
    runWeixinSend(args, dependencies),
    runWeixinSend(args, dependencies),
  ]);

  assert.deepEqual(delivered, ['早报正文']);
});

test('weixin send resumes after a partial chunked delivery instead of re-sending delivered segments', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-weixin-send-resume-'));
  const digestPath = path.join(tmpDir, 'digest.md');
  const delivered: string[] = [];
  fs.writeFileSync(digestPath, ['第一段', '第二段', '第三段'].join(CHUNK_SEPARATOR), 'utf8');

  const args = [
    '--state-dir', tmpDir,
    '--to-user-id', 'melody@im.wechat',
    '--text-file', digestPath,
    '--idempotency-key', 'linear-digest-2026-10-08',
  ];
  const clientIdSeeds: Array<string | undefined> = [];
  // The second segment fails on the first run, so only the first is delivered.
  const dependencies = {
    createPlatformPlugin: weixinSendTestPlugin({ delivered, failOnDeliveryIndex: 1, clientIdSeeds }),
  };

  await assert.rejects(() => runWeixinSend(args, dependencies), /transport unavailable/);

  const partial = weixinSendReceipts(tmpDir)['melody@im.wechat:linear-digest-2026-10-08'];
  assert.equal(partial.status, 'partial');
  assert.equal(partial.deliveredDeliveryCount, 1);
  assert.equal(partial.totalDeliveryCount, 3);

  await runWeixinSend(args, dependencies);

  // 第一段 arrived on the first run and must not be sent again.
  assert.deepEqual(delivered, ['第一段', '第二段', '第三段']);
  const final = weixinSendReceipts(tmpDir)['melody@im.wechat:linear-digest-2026-10-08'];
  assert.equal(final.status, 'sent');
  assert.equal(final.deliveredDeliveryCount, 3);
  // The retried segment goes out under the client ids of the first run.
  assert.equal(clientIdSeeds.length, 2);
  assert.ok(clientIdSeeds[0]);
  assert.equal(clientIdSeeds[1], clientIdSeeds[0]);
});

test('weixin send refuses to resume a partial delivery once the text file has changed', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-weixin-send-changed-'));
  const digestPath = path.join(tmpDir, 'digest.md');
  const delivered: string[] = [];
  fs.writeFileSync(digestPath, ['第一段', '第二段', '第三段'].join(CHUNK_SEPARATOR), 'utf8');

  const args = [
    '--state-dir', tmpDir,
    '--to-user-id', 'melody@im.wechat',
    '--text-file', digestPath,
    '--idempotency-key', 'linear-digest-2026-10-09',
  ];
  const dependencies = {
    createPlatformPlugin: weixinSendTestPlugin({ delivered, failOnDeliveryIndex: 1 }),
  };

  await assert.rejects(() => runWeixinSend(args, dependencies), /transport unavailable/);
  assert.deepEqual(delivered, ['第一段']);

  // Regenerated before the retry: skipping one segment of this text would
  // splice the old opening onto the new rest.
  fs.writeFileSync(digestPath, ['新第一段', '新第二段'].join(CHUNK_SEPARATOR), 'utf8');
  await assert.rejects(() => runWeixinSend(args, dependencies), /idempotency key|幂等键/);

  assert.deepEqual(delivered, ['第一段']);
  assert.equal(weixinSendReceipts(tmpDir)['melody@im.wechat:linear-digest-2026-10-09'].status, 'partial');
});

test('weixin send refuses to resume a partial delivery once the same text splits differently', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-weixin-send-resplit-'));
  const digestPath = path.join(tmpDir, 'digest.md');
  const delivered: string[] = [];
  fs.writeFileSync(digestPath, ['第一段', '第二段', '第三段'].join(CHUNK_SEPARATOR), 'utf8');

  const args = [
    '--state-dir', tmpDir,
    '--to-user-id', 'melody@im.wechat',
    '--text-file', digestPath,
    '--idempotency-key', 'linear-digest-2026-10-10',
  ];

  await assert.rejects(() => runWeixinSend(args, {
    createPlatformPlugin: weixinSendTestPlugin({ delivered, failOnDeliveryIndex: 1 }),
  }), /transport unavailable/);
  assert.deepEqual(delivered, ['第一段']);

  // Same file, but a raised length limit now packs the first two segments into
  // one. Skipping one segment of this split would drop 第二段 for good.
  await assert.rejects(() => runWeixinSend(args, {
    createPlatformPlugin: weixinSendTestPlugin({
      delivered,
      splitContent: (content) => {
        const [first, second, ...rest] = content.split(CHUNK_SEPARATOR);
        return [`${first}${CHUNK_SEPARATOR}${second}`, ...rest];
      },
    }),
  }), /idempotency key|幂等键/);

  assert.deepEqual(delivered, ['第一段']);
  assert.equal(weixinSendReceipts(tmpDir)['melody@im.wechat:linear-digest-2026-10-10'].status, 'partial');
});

test('weixin send refuses a text file that formats down to nothing', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-weixin-send-blank-'));
  const digestPath = path.join(tmpDir, 'digest.md');
  const delivered: string[] = [];
  fs.writeFileSync(digestPath, '![封面](https://example.com/cover.png)', 'utf8');

  // Formatting strips image markup, leaving no segment to send.
  await assert.rejects(() => runWeixinSend([
    '--state-dir', tmpDir,
    '--to-user-id', 'melody@im.wechat',
    '--text-file', digestPath,
    '--idempotency-key', 'linear-digest-2026-10-11',
  ], {
    createPlatformPlugin: weixinSendTestPlugin({ delivered, splitContent: () => [] }),
  }), /digest\.md/);

  assert.deepEqual(delivered, []);
  assert.equal(fs.existsSync(path.join(tmpDir, 'runtime', 'weixin-outbound-receipts.json')), false);
});

test('weixin send treats a receipt written before chunk tracking as fully sent', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-weixin-send-legacy-'));
  const digestPath = path.join(tmpDir, 'digest.md');
  const delivered: string[] = [];
  fs.writeFileSync(digestPath, '早报正文', 'utf8');
  fs.mkdirSync(path.join(tmpDir, 'runtime'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'runtime', 'weixin-outbound-receipts.json'),
    JSON.stringify({
      'melody@im.wechat:linear-digest-2026-08-01': {
        sentAt: '2026-08-01T00:00:00.000Z',
        textFile: digestPath,
        toUserId: 'melody@im.wechat',
      },
    }),
    'utf8',
  );

  await runWeixinSend([
    '--state-dir', tmpDir,
    '--to-user-id', 'melody@im.wechat',
    '--text-file', digestPath,
    '--idempotency-key', 'linear-digest-2026-08-01',
  ], {
    createPlatformPlugin: weixinSendTestPlugin({ delivered }),
  });

  assert.deepEqual(delivered, []);
});

test('parseWeixinLoginArgs reads supported CLI flags', () => {
  const parsed = parseWeixinLoginArgs([
    '--base-url', 'https://ilink.example.com',
    '--state-dir', '/tmp/codexbridge-state',
    '--bot-type', '7',
    '--timeout-sec', '120',
  ]);

  assert.equal(parsed.baseUrl, 'https://ilink.example.com');
  assert.equal(parsed.stateDir, '/tmp/codexbridge-state');
  assert.equal(parsed.botType, '7');
  assert.equal(parsed.timeoutSeconds, 120);
});

test('materializeQrArtifact stores data-url qr images on disk', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-cli-'));
  const pngBody = Buffer.from('fake-png-body');
  const result = await materializeQrArtifact({
    stateDir: tmpDir,
    qrcode: 'qr-123',
    qrcodeImageContent: `data:image/png;base64,${pngBody.toString('base64')}`,
  });

  assert.ok(result.filePath);
  assert.equal(fs.existsSync(result.filePath), true);
  assert.deepEqual(fs.readFileSync(result.filePath), pngBody);
  assert.equal(result.sourceUrl, null);
});

test('materializeQrArtifact renders URL qr content into a real png', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-cli-'));
  const result = await materializeQrArtifact({
    stateDir: tmpDir,
    qrcode: 'qr-url-123',
    qrcodeImageContent: 'https://liteapp.weixin.qq.com/q/?qrcode=abc&bot_type=3',
  });

  assert.ok(result.filePath);
  assert.equal(fs.existsSync(result.filePath), true);
  assert.equal(result.sourceUrl, 'https://liteapp.weixin.qq.com/q/?qrcode=abc&bot_type=3');
  assert.deepEqual(
    fs.readFileSync(result.filePath).subarray(0, 8),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
});

test('parseWeixinServeArgs reads state-dir flag', () => {
  const parsed = parseWeixinServeArgs([
    '--state-dir', '/tmp/codexbridge-state',
    '--cwd', '/tmp/project',
  ]);

  assert.equal(parsed.stateDir, '/tmp/codexbridge-state');
  assert.equal(parsed.cwd, '/tmp/project');
});

test('createWeixinServeCodexAuthManager stores account data under runtime/codex-login', () => {
  const manager = createWeixinServeCodexAuthManager('/tmp/codexbridge-state');

  assert.equal(manager.rootDir, codexLoginStateDir('/tmp/codexbridge-state'));
  assert.equal(manager.poolPath, path.join(codexLoginStateDir('/tmp/codexbridge-state'), 'accounts.json'));
});

test('parseWeixinClearContextArgs reads state-dir and account-id flags', () => {
  const parsed = parseWeixinClearContextArgs([
    '--state-dir', '/tmp/codexbridge-state',
    '--account-id', 'bot-account',
  ]);

  assert.equal(parsed.stateDir, '/tmp/codexbridge-state');
  assert.equal(parsed.accountId, 'bot-account');
});

test('parseCodexCleanupInternalThreadsArgs defaults to dry-run and reads apply flags', () => {
  assert.deepEqual(parseCodexCleanupInternalThreadsArgs([]), {
    stateDir: null,
    cwd: null,
    dryRun: true,
    limit: 100_000,
  });

  assert.deepEqual(parseCodexCleanupInternalThreadsArgs([
    '--state-dir', '/tmp/codexbridge-state',
    '--cwd', '/tmp/project',
    '--limit', '250',
    '--apply',
  ]), {
    stateDir: '/tmp/codexbridge-state',
    cwd: '/tmp/project',
    dryRun: false,
    limit: 250,
  });

  assert.equal(parseCodexCleanupInternalThreadsArgs(['--apply', '--dry-run']).dryRun, true);
});

test('parseCodexNativeApiServeArgs reads standalone native-api flags', () => {
  assert.deepEqual(parseCodexNativeApiServeArgs([]), {
    stateDir: null,
    cwd: null,
    host: null,
    port: null,
    providerProfileId: null,
  });

  assert.deepEqual(parseCodexNativeApiServeArgs([
    '--state-dir', '/tmp/codexbridge-state',
    '--cwd', '/tmp/project',
    '--host', '127.0.0.1',
    '--port', '43182',
    '--provider-profile', 'openai-default',
  ]), {
    stateDir: '/tmp/codexbridge-state',
    cwd: '/tmp/project',
    host: '127.0.0.1',
    port: 43182,
    providerProfileId: 'openai-default',
  });
});

test('resolveEmbeddedCodexNativeApiOptions defaults native-api startup to the Codex path', () => {
  const options = resolveEmbeddedCodexNativeApiOptions({
    env: {
      CODEX_NATIVE_API_AUTH_TOKEN: 'native-secret',
    } as NodeJS.ProcessEnv,
    defaultProviderProfileId: 'qwen',
  });

  assert.deepEqual(options, {
    enabled: true,
    host: '127.0.0.1',
    port: 43182,
    providerProfileId: 'openai-default',
    authToken: 'native-secret',
    defaultModel: null,
    requestTitlePrefix: null,
  });
});

test('resolveEmbeddedCodexNativeApiOptions allows explicit native-api opt-out', () => {
  const options = resolveEmbeddedCodexNativeApiOptions({
    env: {
      CODEX_NATIVE_API_ENABLE: '0',
      CODEX_NATIVE_API_AUTH_TOKEN: 'native-secret',
    } as NodeJS.ProcessEnv,
    defaultProviderProfileId: 'openai-default',
  });

  assert.equal(options.enabled, false);
});

test('resolveEmbeddedCodexNativeApiOptions keeps embedded native-api on the Codex path while honoring host/port/model overrides', () => {
  const options = resolveEmbeddedCodexNativeApiOptions({
    env: {
      CODEX_NATIVE_API_ENABLE: 'true',
      CODEX_NATIVE_API_HOST: '127.0.0.2',
      CODEX_NATIVE_API_PORT: '53182',
      CODEX_NATIVE_API_PROVIDER_PROFILE_ID: 'qwen',
      CODEX_NATIVE_API_DEFAULT_MODEL: 'gpt-5.4',
      CODEX_NATIVE_API_TITLE_PREFIX: 'Bridge Native API',
    } as NodeJS.ProcessEnv,
    defaultProviderProfileId: 'openai-default',
  });

  assert.deepEqual(options, {
    enabled: true,
    host: '127.0.0.2',
    port: 53182,
    providerProfileId: 'openai-default',
    authToken: null,
    defaultModel: 'gpt-5.4',
    requestTitlePrefix: 'Bridge Native API',
  });
});

test('resolveClearContextAccountId infers the only saved account', () => {
  assert.equal(resolveClearContextAccountId({
    requestedAccountId: null,
    allAccounts: ['bot-account'],
  }), 'bot-account');
  assert.equal(resolveClearContextAccountId({
    requestedAccountId: null,
    allAccounts: ['bot-a', 'bot-b'],
  }), null);
  assert.equal(resolveClearContextAccountId({
    requestedAccountId: 'bot-b',
    allAccounts: ['bot-a', 'bot-b'],
  }), 'bot-b');
});

test('acquireServeLock prevents duplicate weixin serve processes for the same state dir', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-weixin-lock-'));
  const lockPath = path.join(tmpDir, 'runtime', 'weixin-serve.lock');
  const first = await acquireServeLock(lockPath);

  await assert.rejects(
    () => acquireServeLock(lockPath),
    /already running/i,
  );

  await first.release();
});

test('acquireServeLock lets only one of two simultaneous callers win', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-weixin-lock-race-'));
  const lockPath = path.join(tmpDir, 'runtime', 'weixin-send.lock');
  const outcomes = await Promise.allSettled([
    acquireServeLock(lockPath),
    acquireServeLock(lockPath),
  ]);

  const winners = outcomes.filter((outcome) => outcome.status === 'fulfilled');
  assert.equal(winners.length, 1);
  for (const winner of winners) {
    await (winner as PromiseFulfilledResult<{ release(): Promise<void> }>).value.release();
  }
});

test('acquireServeLock waits for the holder to release when given a wait budget', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-weixin-lock-wait-'));
  const lockPath = path.join(tmpDir, 'runtime', 'weixin-send.lock');
  const first = await acquireServeLock(lockPath);
  const waiting = acquireServeLock(lockPath, { waitMs: 5_000, retryIntervalMs: 10 });

  setTimeout(() => {
    void first.release();
  }, 50);

  const second = await waiting;
  assert.equal(second.lockPath, lockPath);
  await second.release();
});

test('acquireServeLock recovers a stale lock file', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-weixin-lock-'));
  const lockPath = path.join(tmpDir, 'runtime', 'weixin-serve.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 999999,
    startedAt: new Date().toISOString(),
    cwd: '/tmp/stale',
  }));

  const lock = await acquireServeLock(lockPath);
  const payload = JSON.parse(fs.readFileSync(lockPath, 'utf8'));

  assert.equal(payload.pid, process.pid);

  await lock.release();
});

test('acquireServeLock lets only one of two callers reclaim the same stale lock', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-weixin-lock-reclaim-'));
  const lockPath = path.join(tmpDir, 'runtime', 'weixin-send.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 999999,
    startedAt: new Date().toISOString(),
    cwd: '/tmp/stale',
  }));

  // Both callers see the same dead owner. The slower one must not delete the
  // lock the faster one has just published in its place.
  const outcomes = await Promise.allSettled([
    acquireServeLock(lockPath),
    acquireServeLock(lockPath),
  ]);

  const winners = outcomes.filter((outcome) => outcome.status === 'fulfilled');
  assert.equal(winners.length, 1);
  for (const winner of winners) {
    await (winner as PromiseFulfilledResult<{ release(): Promise<void> }>).value.release();
  }
});

test('acquireServeLock recovers a stale lock whose reclaimer also died', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-weixin-lock-reclaimer-'));
  const lockPath = path.join(tmpDir, 'runtime', 'weixin-send.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const staleContent = JSON.stringify({
    pid: 999999,
    startedAt: new Date().toISOString(),
    cwd: '/tmp/stale',
  });
  fs.writeFileSync(lockPath, staleContent);
  const digest = crypto.createHash('sha256').update(staleContent).digest('hex').slice(0, 16);
  fs.writeFileSync(`${lockPath}.reclaim-${digest}`, JSON.stringify({
    pid: 999998,
    startedAt: new Date().toISOString(),
    cwd: '/tmp/stale',
  }));

  const lock = await acquireServeLock(lockPath);

  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, process.pid);
  assert.equal(fs.existsSync(`${lockPath}.reclaim-${digest}`), false);
  await lock.release();
});

test('restart notifications are persisted and flushed after startup', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-weixin-restart-'));
  const sent: Array<{ externalScopeId: string; content: string }> = [];

  await enqueuePendingRestartNotification({
    stateDir: tmpDir,
    externalScopeId: 'wxid_sender',
    content: '桥接已重启完成。\n现在可以继续发消息了。',
  });

  assert.deepEqual(
    readPendingRestartNotifications(pendingRestartNotificationsFile(tmpDir)).map((item) => item.externalScopeId),
    ['wxid_sender'],
  );

  await flushPendingRestartNotifications({
    stateDir: tmpDir,
    platformPlugin: {
      async start() {},
      async sendText({ externalScopeId, content }) {
        sent.push({ externalScopeId, content });
        return {
          success: true,
          deliveredCount: 1,
          deliveredText: content,
          failedIndex: null,
          failedText: '',
          error: '',
        };
      },
    } as any,
  });

  assert.deepEqual(sent, [
    {
      externalScopeId: 'wxid_sender',
      content: '桥接已重启完成。\n现在可以继续发消息了。',
    },
  ]);
  assert.deepEqual(readPendingRestartNotifications(pendingRestartNotificationsFile(tmpDir)), []);
});
