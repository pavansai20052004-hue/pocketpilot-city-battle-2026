import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayName } from './user.js';

test('existing user keeps their name', () => assert.equal(displayName({ name: 'Pavan' }), 'Pavan'));
test('missing user gets Guest', () => assert.equal(displayName(null), 'Guest'));
