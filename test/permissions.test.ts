import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ClusterSession } from '../src/core/cluster';
import { rulesAllow } from '../src/core/permissions';

test('RBAC rules match verbs, groups, subresources and ignore name-restricted rules', () => {
  const rules = [
    { verbs: ['get', 'list', 'watch'], apiGroups: [''], resources: ['pods', 'pods/log'] },
    { verbs: ['create'], apiGroups: [''], resources: ['*/exec'] },
    { verbs: ['*'], apiGroups: ['apps'], resources: ['deployments'] },
    { verbs: ['delete'], apiGroups: [''], resources: ['pods'], resourceNames: ['only-this'] }
  ];
  assert.equal(rulesAllow(rules, 'get', '', 'pods', 'log'), true);
  assert.equal(rulesAllow(rules, 'create', '', 'pods', 'exec'), true);
  assert.equal(rulesAllow(rules, 'create', '', 'pods', 'portforward'), false);
  assert.equal(rulesAllow(rules, 'patch', 'apps', 'deployments'), true);
  assert.equal(rulesAllow(rules, 'patch', '', 'deployments'), false, 'group must match');
  assert.equal(rulesAllow(rules, 'delete', '', 'pods'), false, 'a rule for one named pod does not allow deleting pods');
  assert.equal(rulesAllow([{ verbs: ['*'], apiGroups: ['*'], resources: ['*'] }], 'create', '', 'pods', 'eviction'), true);
});

function fakeSession(responses: { rules?: unknown; access?: boolean }) {
  const calls: string[] = [];
  const session = Object.assign(Object.create(ClusterSession.prototype), {
    accessCache: new Map(),
    rulesCache: new Map(),
    rest: {
      json: async (_method: string, path: string) => {
        calls.push(path.split('/').pop()!);
        if (path.endsWith('selfsubjectrulesreviews')) { return responses.rules; }
        return { status: { allowed: responses.access } };
      }
    }
  }) as ClusterSession;
  return { session, calls };
}

test('one rules review answers all namespaced checks; cluster-wide checks and incomplete rules use access reviews', async () => {
  const complete = fakeSession({ rules: { status: { resourceRules: [{ verbs: ['get'], apiGroups: [''], resources: ['pods/log'] }] } }, access: true });
  assert.equal(await complete.session.can('get', '', 'pods', 'team', 'log'), true);
  assert.equal(await complete.session.can('create', '', 'pods', 'team', 'exec'), false);
  assert.equal(await complete.session.can('delete', '', 'pods', 'team'), false);
  assert.deepEqual(complete.calls, ['selfsubjectrulesreviews']);
  assert.equal(await complete.session.can('patch', '', 'nodes'), true);
  assert.deepEqual(complete.calls, ['selfsubjectrulesreviews', 'selfsubjectaccessreviews']);

  const incomplete = fakeSession({ rules: { status: { resourceRules: [], incomplete: true } }, access: true });
  assert.equal(await incomplete.session.can('delete', '', 'pods', 'team'), true);
  assert.deepEqual(incomplete.calls, ['selfsubjectrulesreviews', 'selfsubjectaccessreviews']);
});
