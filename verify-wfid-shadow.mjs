#!/usr/bin/env node
/**
 * Milestone 2: WF-ID Cross-Shadow Interaction Verification
 *
 * Tests that Webfuse Automation API can:
 * 1. Perceive shadow DOM content with includeShadowDom: true
 * 2. Target elements inside shadow roots by raw WF-ID
 * 3. Click and type through nested shadow boundaries
 *
 * NO custom JS injection. Only act.* and see.* MCP tools.
 *
 * Requires: WEBFUSE_AUTOMATION_KEY, WEBFUSE_COMPANY_KEY
 */
import https from 'node:https';
import fs from 'node:fs';

const API_KEY = process.env.WEBFUSE_AUTOMATION_KEY;
const MCP = 'https://session-mcp.webfu.se/mcp';
const GYM = 'https://gym-diagnostic.webfuse.it';

if (!API_KEY) { console.error('WEBFUSE_AUTOMATION_KEY required'); process.exit(1); }

let mcpSessionId = null;
let callId = 0;

function post(url, body, hdrs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(body), ...hdrs },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body); req.end();
  });
}

function parse(raw) {
  for (const line of raw.split('\n')) {
    if (line.startsWith('data: ')) { try { return JSON.parse(line.slice(6)); } catch {} }
  }
  try { return JSON.parse(raw); } catch { throw new Error('Parse fail: ' + raw.slice(0, 200)); }
}

async function init() {
  const body = JSON.stringify({ jsonrpc: '2.0', id: ++callId, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'shadow-verify', version: '1.0' } } });
  const raw = await post(MCP, body, { Authorization: `Bearer ${API_KEY}` });
  // Extract Mcp-Session-Id from SSE response headers isn't possible with simple post,
  // but the session ID is typically in the response
  const parsed = parse(raw);
  // Try to get session ID from response headers by re-requesting
  // For now, use the raw response to find it
  const sidMatch = raw.match(/Mcp-Session-Id[:\s]+([^\r\n]+)/i);
  if (sidMatch) mcpSessionId = sidMatch[1].trim();
  // Send initialized
  const notifyBody = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const h = { Authorization: `Bearer ${API_KEY}` };
  if (mcpSessionId) h['Mcp-Session-Id'] = mcpSessionId;
  await post(MCP, notifyBody, h);
  console.log('MCP initialized');
}

async function tool(name, args) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: ++callId, method: 'tools/call',
    params: { name, arguments: args } });
  const h = { Authorization: `Bearer ${API_KEY}` };
  if (mcpSessionId) h['Mcp-Session-Id'] = mcpSessionId;
  const raw = await post(MCP, body, h);
  const p = parse(raw);
  if (p.error) throw new Error(`${name}: ${p.error.message}`);
  return (p.result?.content ?? []).find(c => c.type === 'text')?.text ?? '';
}

// Use WebfuseProvider from journey-benchmark for session creation
async function createSession() {
  const { WebfuseProvider } = await import('/home/deploy/projects/journey-benchmark/dist/webfuse/webfuse.js');
  process.env.DIAGNOSTIC_MODE = '1';
  const provider = new WebfuseProvider(true);
  const page = await provider.openUrl(GYM);
  return { provider, api: provider.getAutomationApi(), sid: provider.getActiveSessionId() };
}

// ---- Tests ----

const results = [];

async function test(label, fn) {
  const start = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - start;
    console.log(`  [PASS] ${label} (${ms}ms)${detail ? ': ' + detail.slice(0, 80) : ''}`);
    results.push({ label, status: 'PASS', ms, detail: detail?.slice(0, 200) });
    return true;
  } catch (e) {
    const ms = Date.now() - start;
    console.log(`  [FAIL] ${label} (${ms}ms): ${e.message.slice(0, 100)}`);
    results.push({ label, status: 'FAIL', ms, error: e.message.slice(0, 200) });
    return false;
  }
}

async function main() {
  console.log('=== M2: WF-ID Cross-Shadow Verification ===\n');

  const { provider, api, sid } = await createSession();
  console.log('Session:', sid);
  await new Promise(r => setTimeout(r, 5000));

  // ---- Phase 1: Perception (domSnapshot with includeShadowDom) ----
  console.log('\n--- Phase 1: Perception ---\n');

  // Test 1: Snapshot WITHOUT includeShadowDom (baseline)
  let snapWithout;
  await test('Snapshot WITHOUT includeShadowDom', async () => {
    snapWithout = await api.domSnapshot(sid, { webfuseIDs: true });
    return `${snapWithout.length} chars, has shadow-member-id: ${snapWithout.includes('shadow-member-id')}`;
  });

  // Test 2: Snapshot WITH includeShadowDom
  let snapWith;
  await test('Snapshot WITH includeShadowDom: true', async () => {
    snapWith = await api.domSnapshot(sid, { webfuseIDs: true, includeShadowDom: true });
    return `${snapWith.length} chars, has shadow-member-id: ${snapWith.includes('shadow-member-id')}`;
  });

  // Test 3: Compare snapshots
  await test('Shadow content visible in enhanced snapshot', async () => {
    if (!snapWith) throw new Error('No snapshot available');
    const hasShadowContent = snapWith.includes('shadow-member-id') || snapWith.includes('Membership');
    const hasGymContent = snapWith.includes('gym-date') || snapWith.includes('component-card') || snapWith.includes('Journey 0');
    if (!hasGymContent) throw new Error('Snapshot does not contain gym page content at all');
    if (!hasShadowContent) throw new Error('includeShadowDom had no effect: shadow content still missing');
    return `Gym content: ${hasGymContent}, Shadow content: ${hasShadowContent}`;
  });

  // Test 4: WF-IDs inside shadow roots
  await test('WF-IDs assigned to shadow DOM elements', async () => {
    if (!snapWith) throw new Error('No snapshot');
    // Find WF-IDs
    const wfIds = [...snapWith.matchAll(/wf-id="(\d+)"/g)].map(m => parseInt(m[1]));
    if (wfIds.length === 0) throw new Error('No WF-IDs found in snapshot');
    // Check if shadow-member-id has a WF-ID nearby
    const shadowIdx = snapWith.indexOf('shadow-member-id');
    if (shadowIdx === -1) throw new Error('shadow-member-id not in snapshot');
    const nearbyWfId = snapWith.substring(Math.max(0, shadowIdx - 100), shadowIdx + 100).match(/wf-id="(\d+)"/);
    if (!nearbyWfId) throw new Error('No WF-ID near shadow-member-id');
    return `${wfIds.length} WF-IDs total. shadow-member-id near wf-id="${nearbyWfId[1]}"`;
  });

  // ---- Phase 2: Actuation (click/type by WF-ID) ----
  console.log('\n--- Phase 2: Cross-Shadow Actuation ---\n');

  // Extract WF-IDs from shadow content
  let shadowInputWfId = null;
  let shadowBtnWfId = null;

  if (snapWith) {
    // Find WF-ID for shadow-member-id
    const inputMatch = snapWith.match(/id="shadow-member-id"[^>]*wf-id="(\d+)"|wf-id="(\d+)"[^>]*id="shadow-member-id"/);
    if (inputMatch) shadowInputWfId = inputMatch[1] || inputMatch[2];
    // Find WF-ID for shadow-verify-btn
    const btnMatch = snapWith.match(/id="shadow-verify-btn"[^>]*wf-id="(\d+)"|wf-id="(\d+)"[^>]*id="shadow-verify-btn"/);
    if (btnMatch) shadowBtnWfId = btnMatch[1] || btnMatch[2];
    console.log(`  Extracted: input WF-ID=${shadowInputWfId}, button WF-ID=${shadowBtnWfId}`);
  }

  // Test 5: Click shadow host (light DOM, should work)
  await test('Click shadow host #gym-shadow-host', async () => {
    return await api.click(sid, '#gym-shadow-host');
  });

  // Test 6: Type into shadow input by WF-ID
  if (shadowInputWfId) {
    await test(`Type into shadow input [wf-id="${shadowInputWfId}"]`, async () => {
      return await api.type(sid, `[wf-id="${shadowInputWfId}"]`, 'GYM-1234', { overwrite: true });
    });
  } else {
    await test('Type into shadow input by WF-ID', async () => {
      throw new Error('Could not extract WF-ID for shadow-member-id from snapshot');
    });
  }

  // Test 7: Click shadow button by WF-ID
  if (shadowBtnWfId) {
    await test(`Click shadow button [wf-id="${shadowBtnWfId}"]`, async () => {
      return await api.click(sid, `[wf-id="${shadowBtnWfId}"]`);
    });
  } else {
    await test('Click shadow button by WF-ID', async () => {
      throw new Error('Could not extract WF-ID for shadow-verify-btn from snapshot');
    });
  }

  // Test 8: Verify status updated
  await test('Verify shadow status shows success', async () => {
    await new Promise(r => setTimeout(r, 1000));
    const snap = await api.domSnapshot(sid, { webfuseIDs: true, includeShadowDom: true });
    const hasSuccess = snap.includes('shadow-status') && snap.includes('success');
    const hasVerified = snap.includes('Membership verified') || snap.includes('GYM-1234');
    if (!hasSuccess && !hasVerified) throw new Error('Status div did not update to success');
    return `success class: ${hasSuccess}, verified text: ${hasVerified}`;
  });

  // ---- Phase 3: Nested Shadow (Gym component #12) ----
  console.log('\n--- Phase 3: Nested Shadow ---\n');

  // Scroll to nested shadow section
  await api.scroll(sid, 'body', 2000);
  await new Promise(r => setTimeout(r, 2000));

  // Get snapshot with nested shadow content
  const nestedSnap = await api.domSnapshot(sid, { webfuseIDs: true, includeShadowDom: true });

  let nestedInputWfId = null;
  let nestedBtnWfId = null;

  const niMatch = nestedSnap.match(/id="nested-input"[^>]*wf-id="(\d+)"|wf-id="(\d+)"[^>]*id="nested-input"/);
  if (niMatch) nestedInputWfId = niMatch[1] || niMatch[2];
  const nbMatch = nestedSnap.match(/id="nested-confirm-btn"[^>]*wf-id="(\d+)"|wf-id="(\d+)"[^>]*id="nested-confirm-btn"/);
  if (nbMatch) nestedBtnWfId = nbMatch[1] || nbMatch[2];
  console.log(`  Extracted: nested input WF-ID=${nestedInputWfId}, nested btn WF-ID=${nestedBtnWfId}`);

  // Test 9: Type into nested shadow input
  if (nestedInputWfId) {
    await test(`Type into nested shadow input [wf-id="${nestedInputWfId}"]`, async () => {
      return await api.type(sid, `[wf-id="${nestedInputWfId}"]`, 'DEEP-42', { overwrite: true });
    });
  } else {
    await test('Nested shadow input visible in snapshot', async () => {
      throw new Error('nested-input not found in shadow-aware snapshot. 2-hop traversal may not be supported.');
    });
  }

  // Test 10: Click nested confirm button
  if (nestedBtnWfId) {
    await test(`Click nested confirm [wf-id="${nestedBtnWfId}"]`, async () => {
      return await api.click(sid, `[wf-id="${nestedBtnWfId}"]`);
    });
  } else {
    await test('Nested shadow button visible in snapshot', async () => {
      throw new Error('nested-confirm-btn not found in shadow-aware snapshot');
    });
  }

  // ---- Phase 4: DelegatesFocus (Gym component #20) ----
  console.log('\n--- Phase 4: DelegatesFocus ---\n');

  await api.scroll(sid, 'body', 2000);
  await new Promise(r => setTimeout(r, 2000));

  const dfSnap = await api.domSnapshot(sid, { webfuseIDs: true, includeShadowDom: true });
  let dfInputWfId = null;
  let dfBtnWfId = null;

  const diMatch = dfSnap.match(/id="df-input"[^>]*wf-id="(\d+)"|wf-id="(\d+)"[^>]*id="df-input"/);
  if (diMatch) dfInputWfId = diMatch[1] || diMatch[2];
  const dbMatch = dfSnap.match(/id="df-submit-btn"[^>]*wf-id="(\d+)"|wf-id="(\d+)"[^>]*id="df-submit-btn"/);
  if (dbMatch) dfBtnWfId = dbMatch[1] || dbMatch[2];
  console.log(`  Extracted: df-input WF-ID=${dfInputWfId}, df-submit WF-ID=${dfBtnWfId}`);

  // Test 11: Type into delegatesFocus input
  if (dfInputWfId) {
    await test(`Type into delegatesFocus input [wf-id="${dfInputWfId}"]`, async () => {
      return await api.type(sid, `[wf-id="${dfInputWfId}"]`, 'FOCUS-88', { overwrite: true });
    });
  } else {
    await test('DelegatesFocus input visible in snapshot', async () => {
      throw new Error('df-input not found in shadow-aware snapshot');
    });
  }

  // Test 12: Click delegatesFocus submit
  if (dfBtnWfId) {
    await test(`Click delegatesFocus submit [wf-id="${dfBtnWfId}"]`, async () => {
      return await api.click(sid, `[wf-id="${dfBtnWfId}"]`);
    });
  } else {
    await test('DelegatesFocus button visible in snapshot', async () => {
      throw new Error('df-submit-btn not found in shadow-aware snapshot');
    });
  }

  // ---- Summary ----
  console.log('\n=== Summary ===');
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  console.log(`${pass} PASS / ${fail} FAIL out of ${results.length} tests`);
  console.log(`Session preserved: ${sid}`);

  // Write results
  fs.writeFileSync('verify-wfid-results.json', JSON.stringify(results, null, 2));
  console.log('Results: verify-wfid-results.json');

  // Don't close provider (diagnostic mode)
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
