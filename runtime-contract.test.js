const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const read = (file) => fs.readFileSync(file, 'utf8');

test('documentation declares the Node.js 20.9 runtime floor', () => {
  assert.match(read('README.md'), /Node\.js\s+20\.9\s*或更高/);
  assert.match(read('CLAUDE.md'), /Node(?:\.js)?\s+20\.9/);
});

test('installer compares Node major and minor versions and explains the 20.9 floor', () => {
  const installer = read('install.sh');
  assert.match(installer, /\bmajor\b/);
  assert.match(installer, /\bminor\b/);
  assert.match(installer, /major\s*[><=].*20|20.*major/s);
  assert.match(installer, /minor\s*[><=].*9|9.*minor/s);
  assert.match(installer, /Node[^\n]*20\.9/);
  assert.doesNotMatch(installer, /process\.versions\.node\.split\("\."\)\[0\].*[-]ge 18/);
});
