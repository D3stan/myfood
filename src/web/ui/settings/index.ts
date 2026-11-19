import { html } from '../../html.ts';
import type { Html } from '../../html.ts';
import type { V } from '../components/bits.ts';
import { data } from './data.ts';
import { dealsPage, storesPage } from '../deals/screen.ts';
import { goals } from '../nutrition/goals.ts';
import { household } from './household.ts';
import { mcp } from './mcp.ts';
import { presets } from './presets.ts';
import { profile } from './profile.ts';
import { siri } from './siri.ts';

/** Pages reachable with data-a="go" data-p="<key>". Rendered instead of the tab while ui.page is non-empty. */
export const PAGES: Record<string, { title: string; render: (v: V) => Html }> = {
  settings: { title: 'Settings', render: settings },
  profile: { title: 'Profile', render: profile },
  goals: { title: 'Nutrition goals', render: goals },
  household: { title: 'Household', render: household },
  presets: { title: 'Presets', render: presets },
  siri: { title: 'Siri Shortcut', render: siri },
  mcp: { title: 'MCP', render: mcp },
  stores: { title: 'Stores', render: storesPage },
  deals: { title: 'Deals', render: dealsPage },
  data: { title: 'Data', render: data },
};

const rows: [string, string][] = [['profile', 'Profile'], ['goals', 'Nutrition goals'], ['household', 'Household'], ['presets', 'Presets'], ['stores', 'Stores'], ['siri', 'Siri Shortcut'], ['mcp', 'MCP'], ['data', 'Data']];

function settings() {
  return html`
    ${rows.map(([p, label]) => html`<button id="go-${p}" class="btn alt" style="display:flex;width:100%;margin:8px 0;justify-content:space-between" data-a="go" data-p="${p}"><span>${label}</span><span aria-hidden="true">›</span></button>`)}
    <div class="row" style="margin-top:20px"><button class="linkbtn" data-a="logout">Sign out</button><span class="small muted right">build ${__BUILD__}</span></div>
  `;
}
