// Runs index.js end-to-end against a mock LifeContext ingest server (no real network, no LLM).
// Covers: Bash `gh issue create` stdout parse, MCP create_pull_request JSON parse, html_url
// preference, issue_write update -> no ingest, no-URL -> no ingest, PR merge capture (Bash `gh pr
// merge` shorthand + MCP merge_pull_request, keyed #merged; underivable-ref -> no ingest), and
// missing API key -> skip.
// Mirrors devsession-claude/test.mjs's harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function startMockServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      requests.push({ url: req.url, headers: req.headers, body: parsed });
      (handler ?? ((_req, _body, res2) => res2.end('{}')))(req, parsed, res);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests })));
}

// Async spawn, not spawnSync: the child talks to the mock server running on THIS process's event
// loop, so a synchronous spawn here would deadlock (same reasoning as devsession-claude/test.mjs).
function runHook(hookInput, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.write(JSON.stringify(hookInput));
    child.stdin.end();
  });
}

test('Bash `gh issue create`: parses the issue URL + title from stdout/command, ingests an x-dev-event, exits 0', async () => {
  const { server, port, requests } = await startMockServer();

  const result = await runHook(
    {
      tool_name: 'Bash',
      tool_input: { command: 'gh issue create --repo MSIH/life-context --title "capture gh events" --label enhancement' },
      tool_response: { stdout: 'https://github.com/MSIH/life-context/issues/89\n', stderr: '' },
      cwd: '/tmp/some-project',
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1);
  const payload = requests[0].body;
  assert.equal(payload.source, 'gh-event-claude');
  assert.equal(payload.source_id, 'https://github.com/MSIH/life-context/issues/89');
  assert.equal(payload.type, 'x-dev-event');
  assert.equal(payload.extra.kind, 'issue');
  assert.equal(payload.extra.number, 89);
  assert.equal(payload.extra.repo, 'MSIH/life-context');
  assert.match(payload.text_repr, /issue #89 "capture gh events" in MSIH\/life-context/);
});

test('MCP create_pull_request: parses html_url + title from the structured response, kind=pr, exits 0', async () => {
  const { server, port, requests } = await startMockServer();

  const result = await runHook(
    {
      tool_name: 'mcp__github__create_pull_request',
      tool_input: { owner: 'MSIH', repo: 'life-context', title: 'wire it up' },
      tool_response: { html_url: 'https://github.com/MSIH/life-context/pull/90', number: 90, title: 'wire it up' },
      cwd: __dirname,
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1);
  const payload = requests[0].body;
  assert.equal(payload.source_id, 'https://github.com/MSIH/life-context/pull/90');
  assert.equal(payload.extra.kind, 'pr');
  assert.equal(payload.extra.number, 90);
  assert.match(payload.text_repr, /pull request #90 "wire it up" in MSIH\/life-context/);
});

test('MCP response with a body link to another issue: prefers html_url, not the first URL in the blob', async () => {
  const { server, port, requests } = await startMockServer();

  const result = await runHook(
    {
      tool_name: 'mcp__github__create_pull_request',
      tool_input: { owner: 'MSIH', repo: 'life-context', title: 'wire it up' },
      // body references issue #5 by full URL; html_url (the created PR) is #90 — the capture must
      // key on html_url, not the first github URL it can find.
      tool_response: {
        body: 'Fixes https://github.com/MSIH/life-context/issues/5',
        html_url: 'https://github.com/MSIH/life-context/pull/90',
        number: 90,
        title: 'wire it up',
      },
      cwd: __dirname,
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.source_id, 'https://github.com/MSIH/life-context/pull/90');
  assert.equal(requests[0].body.extra.kind, 'pr');
  assert.equal(requests[0].body.extra.number, 90);
});

test('MCP issue_write update: has an issue html_url but method=update -> no ingest, exits 0', async () => {
  const { server, port, requests } = await startMockServer();

  const result = await runHook(
    {
      // issue_write handles create AND update; an update still returns the issue's html_url, so
      // without the method guard it would be mis-recorded as "Opened GitHub issue…". Must not ingest.
      tool_name: 'mcp__github__issue_write',
      tool_input: { method: 'update', owner: 'MSIH', repo: 'life-context', issue_number: 89, title: 'edited title' },
      tool_response: { html_url: 'https://github.com/MSIH/life-context/issues/89', number: 89, title: 'edited title' },
      cwd: __dirname,
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 0, 'an issue_write update must not be captured as an Opened event');
});

test('MCP issue_write create: method=create is captured as an x-dev-event, exits 0', async () => {
  const { server, port, requests } = await startMockServer();

  const result = await runHook(
    {
      tool_name: 'mcp__github__issue_write',
      tool_input: { method: 'create', owner: 'MSIH', repo: 'life-context', title: 'new via issue_write' },
      tool_response: { html_url: 'https://github.com/MSIH/life-context/issues/92', number: 92, title: 'new via issue_write' },
      cwd: __dirname,
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1, 'an issue_write create must be captured');
  assert.equal(requests[0].body.source_id, 'https://github.com/MSIH/life-context/issues/92');
  assert.equal(requests[0].body.extra.kind, 'issue');
  assert.equal(requests[0].body.extra.number, 92);
});

test('no issue/PR URL in the tool result -> no ingest, exits 0', async () => {
  const { server, port, requests } = await startMockServer();

  const result = await runHook(
    {
      tool_name: 'Bash',
      tool_input: { command: 'gh issue create --repo MSIH/life-context --title "boom"' },
      tool_response: { stdout: '', stderr: 'GraphQL: something failed', exit_code: 1 },
      cwd: '/tmp/some-project',
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 0, 'a create with no resulting URL must not ingest anything');
});

test('Bash `gh pr merge`: reconstructs the URL from the "owner/repo#N" shorthand, records a Merged event keyed #merged', async () => {
  const { server, port, requests } = await startMockServer();

  const result = await runHook(
    {
      tool_name: 'Bash',
      tool_input: { command: 'gh pr merge 164 --squash' },
      // gh pr merge prints no full URL — only the "owner/repo#N" shorthand.
      tool_response: { stdout: '✓ Squashed and merged pull request MSIH/life-context#164\n', stderr: '' },
      cwd: '/tmp/some-project', // non-git → branch resolves null, text_repr deterministic
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1);
  const payload = requests[0].body;
  assert.equal(payload.source_id, 'https://github.com/MSIH/life-context/pull/164#merged', 'merge keys on a distinct #merged source_id, not the bare URL');
  assert.equal(payload.extra.action, 'merged');
  assert.equal(payload.extra.kind, 'pr');
  assert.equal(payload.extra.number, 164);
  assert.equal(payload.extra.url, 'https://github.com/MSIH/life-context/pull/164', 'extra.url stays the bare PR URL');
  assert.match(payload.text_repr, /^Merged GitHub pull request #164 in MSIH\/life-context\. /);
});

test('MCP merge_pull_request: builds the URL from {owner, repo, pullNumber}, Merged event keyed #merged', async () => {
  const { server, port, requests } = await startMockServer();

  const result = await runHook(
    {
      tool_name: 'mcp__github__merge_pull_request',
      tool_input: { owner: 'MSIH', repo: 'life-context', pullNumber: 170, merge_method: 'squash' },
      tool_response: { sha: 'deadbeef', merged: true },
      cwd: '/tmp/some-project',
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1);
  const payload = requests[0].body;
  assert.equal(payload.source_id, 'https://github.com/MSIH/life-context/pull/170#merged');
  assert.equal(payload.extra.action, 'merged');
  assert.equal(payload.extra.number, 170);
  assert.match(payload.text_repr, /^Merged GitHub pull request #170 in MSIH\/life-context\. /);
});

test('merge with no derivable PR ref (no number/repo anywhere) -> no ingest, exits 0', async () => {
  const { server, port, requests } = await startMockServer();

  const result = await runHook(
    {
      tool_name: 'Bash',
      tool_input: { command: 'gh pr merge --squash' }, // current-branch merge, no number; nothing to key on
      tool_response: { stdout: '', stderr: '' },
      cwd: '/tmp/some-project',
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key' },
  );

  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 0, 'an undecipherable merge must not ingest anything');
  assert.match(result.stderr, /could not resolve merged PR ref/);
});

test('missing LIFECONTEXT_API_KEY -> no-op skip, exits 0, no ingest', async () => {
  const { server, port, requests } = await startMockServer();

  const result = await runHook(
    {
      tool_name: 'Bash',
      tool_input: { command: 'gh issue create --title "x"' },
      tool_response: { stdout: 'https://github.com/MSIH/life-context/issues/91\n' },
      cwd: '/tmp/some-project',
    },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: '' },
  );

  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 0);
  assert.match(result.stderr, /LIFECONTEXT_API_KEY not configured/);
});
