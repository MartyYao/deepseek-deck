import test from 'node:test';
import assert from 'node:assert/strict';
import { compareSemver, parseSemver } from '../version.js';

test('compares DSH rc releases numerically', () => {
  assert.equal(compareSemver('0.1.0-rc.7', '0.1.0-rc.6'), 1);
  assert.equal(compareSemver('0.1.0-rc.6', '0.1.0-rc.7'), -1);
  assert.equal(compareSemver('0.1.0-rc.10', '0.1.0-rc.9'), 1);
});

test('stable releases are newer than same-core pre-releases', () => {
  assert.equal(compareSemver('0.1.0', '0.1.0-rc.7'), 1);
  assert.equal(compareSemver('0.1.0-rc.7', '0.1.0'), -1);
});

test('supports leading v and build metadata', () => {
  assert.equal(compareSemver('v1.2.3+build.2', '1.2.3+build.1'), 0);
  assert.deepEqual(parseSemver('0.1.0-rc.7'), {
    core: [0, 1, 0],
    prerelease: ['rc', 7]
  });
});

test('rejects malformed versions', () => {
  assert.throws(() => compareSemver('not-a-version', '0.1.0'), /invalid SemVer/);
});
