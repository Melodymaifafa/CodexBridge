import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexAppClient } from '../../../src/providers/codex/app_client.js';

const listenerLeakWarnings: Error[] = [];
const recordWarning = (warning: Error) => {
  if (warning.name === 'MaxListenersExceededWarning') {
    listenerLeakWarnings.push(warning);
  }
};

test.beforeEach(() => {
  listenerLeakWarnings.length = 0;
  process.on('warning', recordWarning);
});

test.afterEach(() => {
  process.off('warning', recordWarning);
});

function createClient() {
  let now = 0;
  return new CodexAppClient({
    codexCliBin: 'codex',
    turnPollNow: () => now,
    turnPollSleep: async (ms) => {
      now += ms;
    },
  });
}

function threadWithTurn(threadId: string, turnId: string, status: string, text: string | null = null) {
  return {
    thread: {
      id: threadId,
      name: threadId,
      turns: [{
        id: turnId,
        status,
        items: text ? [{ type: 'assistant_message', text }] : [],
      }],
    },
  };
}

function approvalRequestMessage(rpcId: string, threadId: string, turnId: string) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: rpcId,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId,
      turnId,
      itemId: `item-${rpcId}`,
      reason: 'retry without sandbox?',
      command: 'npm run build',
      availableDecisions: ['accept', 'decline'],
    },
  });
}

function assertNoTurnListeners(client: CodexAppClient) {
  assert.equal(client.listenerCount('notification'), 0);
  assert.equal(client.listenerCount('approval_request'), 0);
}

async function collectListenerLeakWarnings() {
  // process.emitWarning delivers on the next tick.
  await new Promise((resolve) => setImmediate(resolve));
  return listenerLeakWarnings.map((warning) => warning.message);
}

test('CodexAppClient removes turn listeners after each of 11 consecutive turns', async () => {
  const client = createClient();
  let turnCount = 0;
  client.request = async (method, params) => {
    if (method === 'turn/start') {
      turnCount += 1;
      return { turn: { id: `turn-${turnCount}` } };
    }
    if (method === 'thread/read') {
      return threadWithTurn(params.threadId, `turn-${turnCount}`, 'completed', `answer ${turnCount}`);
    }
    throw new Error(`Unexpected method: ${method}`);
  };

  for (let index = 1; index <= 11; index += 1) {
    const result = await client.startTurn({
      threadId: 'thread-1',
      inputText: `message ${index}`,
      timeoutMs: 60_000,
    });
    assert.equal(result.outputText, `answer ${index}`);
    assertNoTurnListeners(client);
  }
  assert.deepEqual(await collectListenerLeakWarnings(), []);
});

test('CodexAppClient stays under the listener limit while 11 turns wait at the same time', async () => {
  const client = createClient();
  const polledThreads = new Set<string>();
  client.request = async (method, params) => {
    if (method === 'turn/start') {
      return { turn: { id: `turn-${params.threadId}` } };
    }
    if (method === 'thread/read') {
      polledThreads.add(params.threadId);
      const allWaiting = polledThreads.size === 11;
      return threadWithTurn(
        params.threadId,
        `turn-${params.threadId}`,
        allWaiting ? 'completed' : 'inProgress',
        allWaiting ? `answer ${params.threadId}` : null,
      );
    }
    throw new Error(`Unexpected method: ${method}`);
  };

  const threadIds = Array.from({ length: 11 }, (_, index) => `thread-${index + 1}`);
  const results = await Promise.all(threadIds.map((threadId) => client.startTurn({
    threadId,
    inputText: 'hello',
    timeoutMs: 600_000,
  })));

  assert.deepEqual(results.map((result) => result.outputText), threadIds.map((threadId) => `answer ${threadId}`));
  assertNoTurnListeners(client);
  assert.deepEqual(await collectListenerLeakWarnings(), []);
});

test('CodexAppClient routes progress and approvals only to the matching concurrent turn', async () => {
  const client = createClient();
  const polledThreads = new Set<string>();
  let eventsSent = false;
  client.request = async (method, params) => {
    if (method === 'turn/start') {
      return { turn: { id: `turn-${params.threadId}` } };
    }
    if (method === 'thread/read') {
      polledThreads.add(params.threadId);
      if (!eventsSent && polledThreads.size === 2) {
        eventsSent = true;
        client.handleMessage(approvalRequestMessage('approval-rpc-2', 'thread-2', 'turn-thread-2'));
        client.emit('notification', {
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-thread-1',
            itemId: 'item-1',
            delta: 'working on thread 1',
          },
        });
      }
      return threadWithTurn(
        params.threadId,
        `turn-${params.threadId}`,
        eventsSent ? 'completed' : 'inProgress',
        eventsSent ? `answer ${params.threadId}` : null,
      );
    }
    throw new Error(`Unexpected method: ${method}`);
  };

  const seen = {
    'thread-1': { progress: [] as string[], approvals: [] as string[] },
    'thread-2': { progress: [] as string[], approvals: [] as string[] },
  };
  await Promise.all((['thread-1', 'thread-2'] as const).map((threadId) => client.startTurn({
    threadId,
    inputText: 'hello',
    timeoutMs: 600_000,
    onProgress: (progress) => {
      seen[threadId].progress.push(progress.text);
    },
    onApprovalRequest: (request) => {
      seen[threadId].approvals.push(request.requestId);
    },
  })));

  assert.deepEqual(seen, {
    'thread-1': { progress: ['working on thread 1'], approvals: [] },
    'thread-2': { progress: [], approvals: ['approval-rpc-2'] },
  });
  assertNoTurnListeners(client);
});

test('CodexAppClient removes turn listeners when polling the turn fails', async () => {
  const client = createClient();
  client.request = async (method) => {
    if (method === 'turn/start') {
      return { turn: { id: 'turn-1' } };
    }
    if (method === 'thread/read') {
      throw new Error('Codex app-server socket is not open');
    }
    throw new Error(`Unexpected method: ${method}`);
  };

  await assert.rejects(
    client.startTurn({ threadId: 'thread-1', inputText: 'hello', timeoutMs: 60_000 }),
    /Codex app-server socket is not open/,
  );
  assertNoTurnListeners(client);
});

test('CodexAppClient removes turn listeners when the turn ends with an error', async () => {
  const client = createClient();
  client.request = async (method) => {
    if (method === 'turn/start') {
      return { turn: { id: 'turn-1' } };
    }
    if (method === 'thread/read') {
      return {
        thread: {
          id: 'thread-1',
          name: 'Thread 1',
          turns: [{ id: 'turn-1', status: 'failed', error: 'model overloaded', items: [] }],
        },
      };
    }
    throw new Error(`Unexpected method: ${method}`);
  };

  await assert.rejects(
    client.startTurn({ threadId: 'thread-1', inputText: 'hello', timeoutMs: 60_000 }),
    /model overloaded/,
  );
  assertNoTurnListeners(client);
});

test('CodexAppClient removes turn listeners when the turn is interrupted', async () => {
  const client = createClient();
  let interrupted = false;
  client.request = async (method) => {
    if (method === 'turn/start') {
      return { turn: { id: 'turn-1' } };
    }
    if (method === 'turn/interrupt') {
      interrupted = true;
      return {};
    }
    if (method === 'thread/read') {
      if (!interrupted) {
        void client.interruptTurn({ threadId: 'thread-1', turnId: 'turn-1' });
        return threadWithTurn('thread-1', 'turn-1', 'inProgress');
      }
      return threadWithTurn('thread-1', 'turn-1', 'interrupted');
    }
    throw new Error(`Unexpected method: ${method}`);
  };

  const result = await client.startTurn({ threadId: 'thread-1', inputText: 'hello', timeoutMs: 60_000 });

  assert.equal(result.outputState, 'interrupted');
  assertNoTurnListeners(client);
});

test('CodexAppClient removes turn listeners when the turn times out', async () => {
  const client = createClient();
  client.request = async (method) => {
    if (method === 'turn/start') {
      return { turn: { id: 'turn-1' } };
    }
    if (method === 'thread/read') {
      return threadWithTurn('thread-1', 'turn-1', 'inProgress');
    }
    throw new Error(`Unexpected method: ${method}`);
  };

  await assert.rejects(
    client.startTurn({ threadId: 'thread-1', inputText: 'hello', timeoutMs: 5_000 }),
    /Timed out waiting for Codex turn turn-1/,
  );
  assertNoTurnListeners(client);
});

test('CodexAppClient removes turn listeners when a turn times out after a late approval answer', async () => {
  const client = createClient();
  let reads = 0;
  client.send = () => {};
  client.request = async (method) => {
    if (method === 'turn/start') {
      return { turn: { id: 'turn-1' } };
    }
    if (method === 'thread/read') {
      reads += 1;
      if (reads === 1) {
        client.handleMessage(approvalRequestMessage('approval-rpc-1', 'thread-1', 'turn-1'));
      }
      if (reads === 10) {
        // Well past the 2s deadline: the wait is still held open by the pending approval.
        assert.equal(client.getPendingApprovals({ threadId: 'thread-1', turnId: 'turn-1' }).length, 1);
        await client.respondToApproval({ requestId: 'approval-rpc-1', option: 3 });
      }
      return threadWithTurn('thread-1', 'turn-1', 'inProgress');
    }
    throw new Error(`Unexpected method: ${method}`);
  };

  await assert.rejects(
    client.startTurn({ threadId: 'thread-1', inputText: 'hello', timeoutMs: 2_000 }),
    /Timed out waiting for Codex turn turn-1/,
  );
  assert.equal(reads, 10);
  assertNoTurnListeners(client);
});
