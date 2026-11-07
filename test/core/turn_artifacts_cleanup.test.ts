import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  cleanupEmptyTurnArtifactDirectories,
  createTurnArtifactContext,
  ensureTurnArtifactDirectories,
  sweepStaleEmptyTurnArtifactDirectories,
} from '../../src/core/turn_artifacts.js';
import { createCodexBridgeRuntime } from '../../src/runtime/bootstrap.js';
import type { TurnArtifactContext } from '../../src/types/core.js';

class FakeProviderPlugin {
  kind: string;
  displayName: string;
  threadCounter: number;
  turnContexts: TurnArtifactContext[];
  onTurn: ((context: TurnArtifactContext) => void) | null;

  constructor(kind: string) {
    this.kind = kind;
    this.displayName = kind;
    this.threadCounter = 0;
    this.turnContexts = [];
    this.onTurn = null;
  }

  async startThread({ providerProfile, cwd, title }: any) {
    this.threadCounter += 1;
    return {
      threadId: `${providerProfile.id}-thread-${this.threadCounter}`,
      cwd: cwd ?? null,
      title: title ?? `thread ${this.threadCounter}`,
      updatedAt: Date.now() + this.threadCounter,
      preview: '',
      turns: [],
    };
  }

  async startTurn({ bridgeSession, inputText, event }: any) {
    const context = event?.metadata?.codexbridge?.turnArtifactContext as TurnArtifactContext;
    assert.ok(context);
    assert.equal(fs.existsSync(context.artifactDir), true);
    assert.equal(fs.existsSync(context.spoolDir), true);
    this.turnContexts.push(context);
    this.onTurn?.(context);
    return {
      outputText: `reply: ${inputText}`,
      turnId: `${bridgeSession.codexThreadId}-turn-${this.turnContexts.length}`,
      threadId: bridgeSession.codexThreadId,
      title: bridgeSession.title,
    };
  }
}

function makeRuntime(defaultCwd: string) {
  const provider = new FakeProviderPlugin('openai-native');
  const now = Date.now();
  const runtime = createCodexBridgeRuntime({
    providerPlugins: [provider],
    providerProfiles: [{
      id: 'openai-default',
      providerKind: 'openai-native',
      displayName: 'OpenAI Default',
      config: {},
      createdAt: now,
      updatedAt: now,
    }],
    defaultProviderProfileId: 'openai-default',
    defaultCwd,
  });
  return { runtime, provider };
}

test('cleanupEmptyTurnArtifactDirectories removes both turn folders when they are empty', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-artifact-cleanup-'));
  const context = createTurnArtifactContext({ bridgeSessionId: 'session-1', cwd: tempDir, intent: null });
  ensureTurnArtifactDirectories(context);

  try {
    cleanupEmptyTurnArtifactDirectories(context);

    assert.equal(fs.existsSync(context.artifactDir), false);
    assert.equal(fs.existsSync(context.spoolDir), false);
    assert.equal(fs.existsSync(path.dirname(context.artifactDir)), true);
    assert.equal(fs.existsSync(path.dirname(context.spoolDir)), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('cleanupEmptyTurnArtifactDirectories keeps turn folders that hold files', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-artifact-cleanup-'));
  const context = createTurnArtifactContext({ bridgeSessionId: 'session-1', cwd: tempDir, intent: null });
  ensureTurnArtifactDirectories(context);
  const artifactFile = path.join(context.artifactDir, 'report.pdf');
  const spoolFile = path.join(context.spoolDir, 'report.pdf');
  fs.writeFileSync(artifactFile, 'pdf');
  fs.writeFileSync(spoolFile, 'pdf');

  try {
    cleanupEmptyTurnArtifactDirectories(context);

    assert.equal(fs.readFileSync(artifactFile, 'utf8'), 'pdf');
    assert.equal(fs.readFileSync(spoolFile, 'utf8'), 'pdf');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('cleanupEmptyTurnArtifactDirectories removes only the empty folder when the other holds a file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-artifact-cleanup-'));
  const context = createTurnArtifactContext({ bridgeSessionId: 'session-1', cwd: tempDir, intent: null });
  ensureTurnArtifactDirectories(context);
  const spoolFile = path.join(context.spoolDir, 'summary.docx');
  fs.writeFileSync(spoolFile, 'word-output');

  try {
    cleanupEmptyTurnArtifactDirectories(context);

    assert.equal(fs.existsSync(context.artifactDir), false);
    assert.equal(fs.readFileSync(spoolFile, 'utf8'), 'word-output');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('cleanupEmptyTurnArtifactDirectories removes empty subfolders bottom-up', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-artifact-cleanup-'));
  const context = createTurnArtifactContext({ bridgeSessionId: 'session-1', cwd: tempDir, intent: null });
  ensureTurnArtifactDirectories(context);
  fs.mkdirSync(path.join(context.artifactDir, 'output', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(context.spoolDir, 'parts'), { recursive: true });

  try {
    cleanupEmptyTurnArtifactDirectories(context);

    assert.equal(fs.existsSync(context.artifactDir), false);
    assert.equal(fs.existsSync(context.spoolDir), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('cleanupEmptyTurnArtifactDirectories keeps every folder on the path to a file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-artifact-cleanup-'));
  const context = createTurnArtifactContext({ bridgeSessionId: 'session-1', cwd: tempDir, intent: null });
  ensureTurnArtifactDirectories(context);
  const reportFile = path.join(context.artifactDir, 'output', 'report.pdf');
  fs.mkdirSync(path.join(context.artifactDir, 'output', 'tmp'), { recursive: true });
  fs.mkdirSync(path.join(context.artifactDir, 'scratch'));
  fs.writeFileSync(reportFile, 'pdf');

  try {
    cleanupEmptyTurnArtifactDirectories(context);

    assert.equal(fs.readFileSync(reportFile, 'utf8'), 'pdf');
    assert.equal(fs.existsSync(path.join(context.artifactDir, 'output', 'tmp')), false);
    assert.equal(fs.existsSync(path.join(context.artifactDir, 'scratch')), false);
    assert.equal(fs.existsSync(context.spoolDir), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('cleanupEmptyTurnArtifactDirectories keeps a symlink and leaves its target alone', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-artifact-cleanup-'));
  const context = createTurnArtifactContext({ bridgeSessionId: 'session-1', cwd: tempDir, intent: null });
  ensureTurnArtifactDirectories(context);
  const outsideDir = path.join(tempDir, 'outside', 'empty');
  const symlinkPath = path.join(context.artifactDir, 'link');
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.symlinkSync(outsideDir, symlinkPath, 'junction');

  try {
    cleanupEmptyTurnArtifactDirectories(context);

    assert.equal(fs.lstatSync(symlinkPath).isSymbolicLink(), true);
    assert.equal(fs.existsSync(outsideDir), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('cleanupEmptyTurnArtifactDirectories does not follow a turn folder replaced by a symlink', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-artifact-cleanup-'));
  const context = createTurnArtifactContext({ bridgeSessionId: 'session-1', cwd: tempDir, intent: null });
  ensureTurnArtifactDirectories(context);
  const outsideDir = path.join(tempDir, 'outside');
  const outsideEmptyDir = path.join(outsideDir, 'empty');
  fs.mkdirSync(outsideEmptyDir, { recursive: true });
  fs.rmdirSync(context.artifactDir);
  fs.symlinkSync(outsideDir, context.artifactDir, 'junction');

  try {
    cleanupEmptyTurnArtifactDirectories(context);

    assert.equal(fs.lstatSync(context.artifactDir).isSymbolicLink(), true);
    assert.equal(fs.existsSync(outsideEmptyDir), true);
    assert.equal(fs.existsSync(context.spoolDir), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('cleanupEmptyTurnArtifactDirectories ignores missing folders and a missing context', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-artifact-cleanup-'));
  const context = createTurnArtifactContext({ bridgeSessionId: 'session-1', cwd: tempDir, intent: null });

  try {
    assert.doesNotThrow(() => cleanupEmptyTurnArtifactDirectories(context));
    assert.doesNotThrow(() => cleanupEmptyTurnArtifactDirectories(null));
    assert.doesNotThrow(() => cleanupEmptyTurnArtifactDirectories(undefined));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

const HOUR_MS = 60 * 60 * 1000;

function makeSweepFolder(
  baseDir: string,
  rootName: string,
  name: string,
  ageMs: number,
  files: Record<string, string> = {},
): string {
  const dir = path.join(baseDir, '.codexbridge', rootName, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [fileName, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, fileName), content);
  }
  const time = new Date(Date.now() - ageMs);
  fs.utimesSync(dir, time, time);
  return dir;
}

test('sweepStaleEmptyTurnArtifactDirectories removes empty folders older than an hour', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-artifact-sweep-'));
  const oldArtifactDir = makeSweepFolder(tempDir, 'turn-artifacts', 'old-turn', 2 * HOUR_MS);
  const oldSpoolDir = makeSweepFolder(tempDir, 'artifact-spool', 'old-turn', 2 * HOUR_MS);

  try {
    assert.equal(sweepStaleEmptyTurnArtifactDirectories({ homeDir: tempDir }), 2);

    assert.equal(fs.existsSync(oldArtifactDir), false);
    assert.equal(fs.existsSync(oldSpoolDir), false);
    assert.equal(fs.existsSync(path.dirname(oldArtifactDir)), true);
    assert.equal(fs.existsSync(path.dirname(oldSpoolDir)), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('sweepStaleEmptyTurnArtifactDirectories keeps an old folder that holds a file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-artifact-sweep-'));
  const artifactDir = makeSweepFolder(tempDir, 'turn-artifacts', 'old-turn', 2 * HOUR_MS, { 'report.pdf': 'pdf' });
  const spoolDir = makeSweepFolder(tempDir, 'artifact-spool', 'old-turn', 2 * HOUR_MS, { 'report.pdf': 'pdf' });

  try {
    assert.equal(sweepStaleEmptyTurnArtifactDirectories({ homeDir: tempDir }), 0);

    assert.equal(fs.readFileSync(path.join(artifactDir, 'report.pdf'), 'utf8'), 'pdf');
    assert.equal(fs.readFileSync(path.join(spoolDir, 'report.pdf'), 'utf8'), 'pdf');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('sweepStaleEmptyTurnArtifactDirectories keeps a fresh empty folder of a running turn', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-artifact-sweep-'));
  const freshArtifactDir = makeSweepFolder(tempDir, 'turn-artifacts', 'running-turn', 5 * 60 * 1000);
  const freshSpoolDir = makeSweepFolder(tempDir, 'artifact-spool', 'running-turn', 5 * 60 * 1000);

  try {
    assert.equal(sweepStaleEmptyTurnArtifactDirectories({ homeDir: tempDir }), 0);

    assert.equal(fs.existsSync(freshArtifactDir), true);
    assert.equal(fs.existsSync(freshSpoolDir), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('sweepStaleEmptyTurnArtifactDirectories sweeps working-directory roots as well as home', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-artifact-sweep-'));
  const homeDir = path.join(tempDir, 'home');
  const workspaceDir = path.join(tempDir, 'workspace');
  const homeArtifactDir = makeSweepFolder(homeDir, 'turn-artifacts', 'old-turn', 2 * HOUR_MS);
  const workspaceArtifactDir = makeSweepFolder(workspaceDir, 'turn-artifacts', 'old-turn', 2 * HOUR_MS);
  const workspaceSpoolDir = makeSweepFolder(workspaceDir, 'artifact-spool', 'old-turn', 2 * HOUR_MS);
  const workspaceFileDir = makeSweepFolder(workspaceDir, 'turn-artifacts', 'kept-turn', 2 * HOUR_MS, { 'report.pdf': 'pdf' });

  try {
    assert.equal(sweepStaleEmptyTurnArtifactDirectories({
      homeDir,
      cwds: [workspaceDir, `${workspaceDir}/`, homeDir, null, '  '],
    }), 3);

    assert.equal(fs.existsSync(homeArtifactDir), false);
    assert.equal(fs.existsSync(workspaceArtifactDir), false);
    assert.equal(fs.existsSync(workspaceSpoolDir), false);
    assert.equal(fs.readFileSync(path.join(workspaceFileDir, 'report.pdf'), 'utf8'), 'pdf');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('sweepStaleEmptyTurnArtifactDirectories ignores missing roots', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-artifact-sweep-'));

  try {
    assert.equal(sweepStaleEmptyTurnArtifactDirectories({ homeDir: tempDir }), 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('bridge coordinator removes the empty turn folders after a turn ends', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-artifact-cleanup-'));
  const { runtime, provider } = makeRuntime(tempDir);

  try {
    const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-cleanup-ok',
      text: 'hello',
    });

    assert.match(result.messages[0]?.text ?? '', /reply: hello/);
    assert.equal(provider.turnContexts.length, 1);
    const [context] = provider.turnContexts;
    assert.ok(context.artifactDir.startsWith(tempDir));
    assert.equal(fs.existsSync(context.artifactDir), false);
    assert.equal(fs.existsSync(context.spoolDir), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('bridge coordinator removes the empty turn folders when the turn throws', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-artifact-cleanup-'));
  const { runtime, provider } = makeRuntime(tempDir);
  provider.onTurn = () => {
    throw new Error('provider exploded');
  };

  try {
    await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-cleanup-error',
      text: 'hello',
    }).catch(() => null);

    assert.ok(provider.turnContexts.length >= 1);
    for (const context of provider.turnContexts) {
      assert.ok(context.artifactDir.startsWith(tempDir));
      assert.equal(fs.existsSync(context.artifactDir), false);
      assert.equal(fs.existsSync(context.spoolDir), false);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('bridge coordinator removes empty subfolders a failed turn left behind', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-artifact-cleanup-'));
  const { runtime, provider } = makeRuntime(tempDir);
  provider.onTurn = (context) => {
    fs.mkdirSync(path.join(context.artifactDir, 'output'), { recursive: true });
    throw new Error('provider exploded');
  };

  try {
    await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-cleanup-nested',
      text: 'hello',
    }).catch(() => null);

    assert.ok(provider.turnContexts.length >= 1);
    for (const context of provider.turnContexts) {
      assert.ok(context.artifactDir.startsWith(tempDir));
      assert.equal(fs.existsSync(context.artifactDir), false);
      assert.equal(fs.existsSync(context.spoolDir), false);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('bridge coordinator keeps a turn folder that holds a file the model wrote', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-artifact-cleanup-'));
  const { runtime, provider } = makeRuntime(tempDir);
  provider.onTurn = (context) => {
    fs.writeFileSync(path.join(context.artifactDir, 'notes.md'), '# notes');
  };

  try {
    await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-cleanup-file',
      text: 'hello',
    });

    assert.equal(provider.turnContexts.length, 1);
    const [context] = provider.turnContexts;
    assert.equal(fs.readFileSync(path.join(context.artifactDir, 'notes.md'), 'utf8'), '# notes');
    assert.equal(fs.existsSync(context.spoolDir), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
