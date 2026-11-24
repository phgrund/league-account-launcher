require('./helpers/fake-electron');
const test = require('node:test');
const assert = require('node:assert/strict');
const { executeAccountLaunch } = require('../src/main/ipc/launch');

test('an unknown account is reported, nothing else happens', async () => {
    const res = await executeAccountLaunch('does-not-exist');
    assert.deepEqual(res, { success: false, message: 'Account not found' });
});
