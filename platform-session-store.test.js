'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');

const { PlatformSessionStore } = require('./platform-session-store');

async function fixture() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'platform-session-store-'));
}

test('persists only safe session metadata and accepts the documented states', async () => {
  const root = await fixture();
  const now = () => 1_700_000_000_000;
  const sessions = new PlatformSessionStore(root, { now });
  await sessions.load();

  const saved = await sessions.setStatus('taobao', 'default', 'waiting_for_scan', {
    accountName: '默认账号',
    lastVerifiedAt: 1_699_999_999_000,
    errorCode: 'qr_expired'
  });

  assert.equal(saved.status, 'waiting_for_scan');
  assert.equal(saved.accountName, '默认账号');
  assert.equal(saved.updatedAt, now());
  await assert.rejects(() => sessions.setStatus('taobao', 'default', 'not-a-state'), /状态/);
  await assert.rejects(
    () => sessions.setStatus('taobao', 'default', 'ready', { cookie: 'secret' }),
    /敏感/
  );

  const raw = JSON.parse(await fsp.readFile(path.join(root, 'sessions.json'), 'utf8'));
  assert.equal(raw.taobao.default.cookie, undefined);
  assert.equal(raw.taobao.default.token, undefined);
  await assert.rejects(() => fsp.access(path.join(root, 'sessions.json.tmp')));
});

test('reloads sessions and strips sensitive fields from legacy disk data', async () => {
  const root = await fixture();
  await fsp.writeFile(path.join(root, 'sessions.json'), JSON.stringify({
    taobao: {
      default: {
        platform: 'taobao', accountId: 'default', status: 'ready', updatedAt: 4,
        cookie: 'secret', token: 'secret', browserContext: '/private/path'
      }
    }
  }));

  const sessions = new PlatformSessionStore(root, { now: () => 5 });
  await sessions.load();
  const loaded = sessions.get('taobao', 'default');
  assert.equal(loaded.status, 'ready');
  assert.equal(loaded.cookie, undefined);
  assert.equal(loaded.token, undefined);
  assert.equal(loaded.browserContext, undefined);

  await sessions.setStatus('taobao', 'default', 'ready');
  const persisted = JSON.parse(await fsp.readFile(path.join(root, 'sessions.json'), 'utf8'));
  assert.equal(persisted.taobao.default.cookie, undefined);
  assert.equal(persisted.taobao.default.token, undefined);
});

test('returns null for an unknown account and rejects unsafe identifiers', async () => {
  const root = await fixture();
  const sessions = new PlatformSessionStore(root);
  await sessions.load();
  assert.equal(sessions.get('taobao', 'missing'), null);
  assert.throws(() => sessions.get('../escape', 'default'), /参数|标识/);
  assert.throws(() => sessions.get('taobao', '../escape'), /参数|标识/);
});
