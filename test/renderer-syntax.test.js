// The renderer scripts are plain <script> files the tests do not load whole:
// a syntax error (two "const badges" in one function) only showed in the app,
// as a blank window. Every script must at least parse.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const dir = path.join(__dirname, '..', 'src', 'renderer', 'js');

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    test(`${file} parses`, () => {
        const src = fs.readFileSync(path.join(dir, file), 'utf8');
        assert.doesNotThrow(() => new Function(src), file);
    });
}

test('the renderer starts with the launcher API exposed as an immutable window property', async () => {
    const html = fs.readFileSync(path.join(dir, '..', 'index.html'), 'utf8');
    const elements = new Map([...html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)].map(([tag, id]) => [id, {
        hidden: /\shidden(?:\s|>)/.test(tag),
        disabled: /\sdisabled(?:\s|>)/.test(tag),
        addEventListener() {},
        querySelector() { return this; },
        replaceChildren() {},
    }]));
    const api = {
        onLoginStatus() {},
        onDataFileProblem() {},
        onAccountsUpdated() {},
        getVaultState: async () => ({ unlocked: true }),
        getAccounts: async () => [],
    };
    const document = {
        getElementById: id => elements.get(id),
        querySelectorAll: () => [],
    };
    const context = vm.createContext({ document, api });
    vm.runInContext(`
        globalThis.window = globalThis;
        Object.defineProperty(window, 'launcher', { value: api });
    `, context);

    const script = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
    await vm.runInContext(script, context);

    assert.equal(elements.get('accounts-view').hidden, false);
    assert.equal(elements.get('empty').hidden, false);
    assert.equal(elements.get('open-settings').disabled, false);
});
