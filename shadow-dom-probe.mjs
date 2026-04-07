#!/usr/bin/env node
/**
 * Shadow DOM Probe: Tests Webfuse Automation API's ability to target
 * elements inside shadow roots using WF-IDs and various selector strategies.
 *
 * Target: https://gym-diagnostic.webfuse.it (components 7, 12, 13, 20)
 * Constraint: NO custom JS injection. Only act.* and see.* MCP tools.
 *
 * Environment:
 *   WEBFUSE_AUTOMATION_KEY  — ak_* key
 *   WEBFUSE_COMPANY_KEY     — ck_* key (optional, for session creation)
 */
import https from 'node:https';

const API_KEY = process.env.WEBFUSE_AUTOMATION_KEY;
const CK = process.env.WEBFUSE_COMPANY_KEY;
const MCP_ENDPOINT = 'https://session-mcp.webfu.se/mcp';
const GYM_URL = 'https://gym-diagnostic.webfuse.it';
const SPACE = process.env.WEBFUSE_SPACE_SLUG ?? 'webfuse-mcp-demo';

if (!API_KEY) { console.error('WEBFUSE_AUTOMATION_KEY required'); process.exit(1); }

// --- MCP Client ---
let mcpSessionId = null;
let callCounter = 0;

function post(url, body, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname, port: 443,
      path: parsed.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(body), ...headers },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body); req.end();
  });
}

function parseSse(raw) {
  for (const line of raw.split('\n')) {
    if (line.startsWith('data: ')) {
      try { return JSON.parse(line.slice(6)); } catch {}
    }
  }
  try { return JSON.parse(raw); } catch {
    throw new Error('Failed to parse: ' + raw.slice(0, 200));
  }
}

async function initMcp() {
  const initBody = JSON.stringify({ jsonrpc: '2.0', id: ++callCounter, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'shadow-probe', version: '1.0' } } });
  const resp = await post(MCP_ENDPOINT, initBody, { Authorization: `Bearer ${API_KEY}` });
  const parsed = parseSse(resp.body);
  mcpSessionId = resp.headers['mcp-session-id'] ?? null;
  console.log('MCP initialized. Session:', mcpSessionId?.slice(0, 20));

  // Send initialized notification
  const notifyBody = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const notifyHeaders = { Authorization: `Bearer ${API_KEY}` };
  if (mcpSessionId) notifyHeaders['Mcp-Session-Id'] = mcpSessionId;
  await post(MCP_ENDPOINT, notifyBody, notifyHeaders);
}

async function callTool(name, args) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: ++callCounter, method: 'tools/call',
    params: { name, arguments: args } });
  const headers = { Authorization: `Bearer ${API_KEY}` };
  if (mcpSessionId) headers['Mcp-Session-Id'] = mcpSessionId;
  const resp = await post(MCP_ENDPOINT, body, headers);
  const parsed = parseSse(resp.body);
  if (parsed.error) throw new Error(`${name}: ${parsed.error.message}`);
  const content = parsed.result?.content ?? [];
  const text = content.find(c => c.type === 'text')?.text ?? '';
  return text;
}

// --- Session Management ---
async function createSession(url) {
  // Use REST API to create session
  const restBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'session.create', arguments: { space: SPACE, url } } });
  const restHeaders = { Authorization: `Bearer ${CK ?? API_KEY}` };
  const resp = await post('https://mcp.webfu.se/mcp', restBody, restHeaders);
  const parsed = parseSse(resp.body);
  const text = parsed.result?.content?.find(c => c.type === 'text')?.text ?? '';
  const match = text.match(/Session ID: (s\w+)/);
  if (match) return match[1];
  // Try JSON parse
  try {
    const j = JSON.parse(text);
    return j.session_id ?? j.sessionId;
  } catch {}
  console.log('Session create response:', text.slice(0, 200));
  throw new Error('Could not extract session ID');
}

// --- Probe Tests ---
async function probe(sid) {
  const results = [];

  async function test(label, fn) {
    try {
      const r = await fn();
      console.log(`  [PASS] ${label}: ${r.slice(0, 80)}`);
      results.push({ label, status: 'PASS', result: r.slice(0, 200) });
    } catch (e) {
      console.log(`  [FAIL] ${label}: ${e.message.slice(0, 80)}`);
      results.push({ label, status: 'FAIL', error: e.message.slice(0, 200) });
    }
  }

  // Navigate
  await callTool('navigate', { session_id: sid, url: GYM_URL });
  await new Promise(r => setTimeout(r, 5000));
  console.log('Navigated to Gym');

  // Scroll to shadow section
  await callTool('act.scroll', { session_id: sid, target: 'body', value: 1500 });
  await new Promise(r => setTimeout(r, 2000));

  console.log('\n=== Shadow DOM Targeting Strategies ===\n');

  // Strategy 1: Direct CSS selector (expected to fail)
  await test('CSS #shadow-member-id', () => callTool('act.click', { session_id: sid, target: '#shadow-member-id' }));

  // Strategy 2: Shadow host click
  await test('CSS #gym-shadow-host', () => callTool('act.click', { session_id: sid, target: '#gym-shadow-host' }));

  // Strategy 3: WF-ID targeting (try a range of IDs near the shadow host)
  const dom = await callTool('see.domSnapshot', { session_id: sid, options: { webfuseIDs: true } });
  console.log('\n  domSnapshot length:', dom.length);
  const wfIds = [...dom.matchAll(/wf-id="(\d+)"/g)].map(m => parseInt(m[1]));
  console.log('  WF-IDs in snapshot:', wfIds.length, wfIds.length > 0 ? `(${Math.min(...wfIds)}-${Math.max(...wfIds)})` : '');

  // Strategy 4: Try high WF-IDs that might be shadow content
  if (wfIds.length > 0) {
    const maxId = Math.max(...wfIds);
    for (let id = maxId + 1; id <= maxId + 20; id++) {
      await test(`WF-ID [wf-id="${id}"]`, () => callTool('act.click', { session_id: sid, target: `[wf-id="${id}"]` }));
    }
  }

  // Strategy 5: Try accessibility tree for shadow content
  const ax = await callTool('see.accessibilityTree', { session_id: sid });
  console.log('\n  AX tree length:', ax.length);
  console.log('  AX has "Membership":', ax.includes('Membership'));
  console.log('  AX has "input":', ax.includes('input'));

  // Strategy 6: Type into shadow host (Webfuse might delegate to inner input)
  await test('Type into #gym-shadow-host', () => callTool('act.type', { session_id: sid, target: '#gym-shadow-host', value: 'GYM-1234' }));

  // Strategy 7: Navigate directly to shadow section with anchor
  await test('Navigate with hash', () => callTool('navigate', { session_id: sid, url: GYM_URL + '#card-shadow' }));
  await new Promise(r => setTimeout(r, 2000));

  // Re-check domSnapshot after hash navigation
  const dom2 = await callTool('see.domSnapshot', { session_id: sid, options: { webfuseIDs: true } });
  console.log('\n  domSnapshot after hash:', dom2.length);
  console.log('  Has shadow-host:', dom2.includes('shadow-host'));
  console.log('  Has shadow-member:', dom2.includes('shadow-member'));

  // Strategy 8: Try nested shadow
  await test('CSS #gym-nested-shadow-outer', () => callTool('act.click', { session_id: sid, target: '#gym-nested-shadow-outer' }));
  await test('CSS #nested-input', () => callTool('act.type', { session_id: sid, target: '#nested-input', value: 'DEEP-42' }));
  await test('CSS #inner-host', () => callTool('act.click', { session_id: sid, target: '#inner-host' }));

  // Summary
  console.log('\n=== Summary ===');
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  console.log(`${pass} PASS / ${fail} FAIL`);

  return results;
}

// --- Main ---
async function main() {
  await initMcp();

  // Create session
  console.log('Creating session on space:', SPACE);
  const sid = await createSession(GYM_URL);
  console.log('Session:', sid);

  const results = await probe(sid);

  // Write results
  const fs = await import('fs');
  fs.writeFileSync('shadow-probe-results.json', JSON.stringify(results, null, 2));
  console.log('\nResults written to shadow-probe-results.json');
  console.log('Session preserved:', sid);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
