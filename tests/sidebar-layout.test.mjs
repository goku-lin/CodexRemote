import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('sidebar unifies pending items and keeps historical usage separate from header quota and composer metrics',async()=>{
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const sidebar=html.slice(html.indexOf('<aside'),html.indexOf('</aside>'));
  assert.equal((sidebar.match(/data-session-filter="waiting"/g) || []).length,1);
  assert.equal((sidebar.match(/id="attentionBtn"/g) || []).length,1);
  assert.match(sidebar,/data-session-filter="waiting".*id="nextPendingSidebar".*下一个处理/);
  assert.doesNotMatch(sidebar,/data-session-filter="unread"|下一条未读|id="usageOpenBtn"/);
  const header=html.slice(html.indexOf('<header'),html.indexOf('</header>'));
  assert.match(header,/id="usageOpenBtn"/);assert.match(header,/id="usageQuotaSummary"/);
  assert.doesNotMatch(header,/id="usageTokenSummary"|id="usageSpeedSummary"/);
  assert.match(sidebar,/id="historyUsageOpenBtn".*aria-controls="historyUsageModal".*id="usageTokenSummary"/);
  const composer=html.slice(html.indexOf('<div class="composer"'),html.indexOf('<aside class="inspector"'));
  assert.match(composer,/class="composer-metrics".*id="usageSpeedSummary".*id="composerActivity"/);
  assert.match(html,/id="historyUsageModal" role="dialog".*aria-labelledby="historyUsageTitle"/);
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);
  assert.equal(new Set(ids).size,ids.length,'relocated controls must not leave duplicate IDs');
  assert.doesNotMatch(sidebar,/attention-tools|unread-sidebar|等待处理/);
  assert.match(sidebar,/id="noticeSettingsBtn".*aria-controls="noticeSettings"/);
  assert.doesNotMatch(html,/id="deviceSelect"|class="device-picker"/);
  assert.match(html,/id="projectSortStatus".*aria-live="polite"/);
  assert.match(sidebar,/id="chatgptSidebar"[\s\S]*id="chatgptThreadList"/);
  assert.doesNotMatch(html,/id="chatgptBackToCodexBtn"|id="floatingCodexExit"|id="floatingInspectorRestore"|class="chatgpt-threads"/);
});
