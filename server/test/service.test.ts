import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NEEDS_FULL_DISK_ACCESS } from '@imb/shared';
import { RotatingLog } from '../src/logs.ts';
import { buildDegradedApp, canRead } from '../src/degraded.ts';
import { AutomationCheck } from '../src/automation.ts';

test('RotatingLog moves the file aside once it passes the cap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'imb-log-'));
  try {
    const path = join(dir, 'nested', 'server.log');
    const log = new RotatingLog(path, 100);
    for (let i = 0; i < 5; i++) log.write(`${'x'.repeat(30)}\n`);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(`${path}.1`), 'rotated file exists');
    assert.ok(readFileSync(path, 'utf8').length < 100, 'current file restarted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('degraded server: 503 with the reason on the API, ping and the client still work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'imb-degraded-'));
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist', 'index.html'), '<!doctype html><title>bridge</title>');
  const app = buildDegradedApp(join(dir, 'dist'), false);
  try {
    assert.equal((await app.inject({ url: '/api/ping' })).statusCode, 200);
    const res = await app.inject({ url: '/api/conversations' });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error, NEEDS_FULL_DISK_ACCESS);
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/pair' })).statusCode, 503);
    const page = await app.inject({ url: '/c/anything' });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /bridge/);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('canRead reports unreadable files', () => {
  assert.equal(canRead('/nonexistent/chat.db'), false);
  assert.equal(canRead(import.meta.filename), true);
});

test('AutomationCheck turns probe results into states', async () => {
  const states = await Promise.all([
    new AutomationCheck(async () => ({ error: null, timedOut: false })).check(),
    new AutomationCheck(async () => ({ error: 'Not authorized to send Apple events to Messages. (-1743)', timedOut: false })).check(),
    new AutomationCheck(async () => ({ error: 'Command failed', timedOut: true })).check(),
    new AutomationCheck(async () => ({ error: 'something else', timedOut: false })).check(),
  ]);
  assert.deepEqual(states, ['granted', 'denied', 'waiting', 'error']);
});

test('AutomationCheck shares one probe between concurrent checks', async () => {
  let runs = 0;
  const check = new AutomationCheck(async () => {
    runs++;
    await new Promise((r) => setTimeout(r, 20));
    return { error: null, timedOut: false };
  });
  await Promise.all([check.check(), check.check()]);
  assert.equal(runs, 1);
  assert.equal(check.state, 'granted');
  assert.ok(check.checkedAt);
});
