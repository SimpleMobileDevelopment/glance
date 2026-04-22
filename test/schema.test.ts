import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProject } from '../src/schema.ts';

test('schema · valid minimal project', () => {
  const raw = {
    displayName: 'Test',
    github: { username: 'foo', tokenEnv: 'GITHUB_TOKEN' },
    widgets: {},
  };
  const result = parseProject(raw);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.project.displayName, 'Test');
  }
});

test('schema · missing displayName', () => {
  const raw = {
    github: { username: 'foo', tokenEnv: 'GITHUB_TOKEN' },
    widgets: {},
  };
  const result = parseProject(raw);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.issues.some(i => i.includes('displayName')),
      `expected an issue mentioning displayName, got: ${result.issues.join('; ')}`,
    );
  }
});

test('schema · empty displayName rejected', () => {
  const raw = {
    displayName: '',
    github: { username: 'foo', tokenEnv: 'GITHUB_TOKEN' },
    widgets: {},
  };
  const result = parseProject(raw);
  assert.equal(result.ok, false);
});

test('schema · missing github block', () => {
  const raw = {
    displayName: 'Test',
    widgets: {},
  };
  const result = parseProject(raw);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.issues.some(i => i.includes('github')),
      `expected an issue mentioning github, got: ${result.issues.join('; ')}`,
    );
  }
});

test('schema · completely wrong shape', () => {
  const result = parseProject('not an object');
  assert.equal(result.ok, false);
});
