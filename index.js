// Ops Digest — Railway Cron Job
// Once a day, compiles every Slack message that tags the Operations user group
// (top-level messages and thread replies) and posts the digest to one channel.

const { WebClient } = require('@slack/web-api');

const env = process.env;
const SLACK_BOT_TOKEN = env.SLACK_BOT_TOKEN;
const DIGEST_CHANNEL_ID = env.DIGEST_CHANNEL_ID;
const OPS_GROUP_HANDLE = (env.OPS_GROUP_HANDLE ?? 'ops-management').replace(/^@/, '').trim();
const EXTRA_TARGET_IDS = (env.EXTRA_TARGET_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const LOOKBACK_HOURS = Number(env.LOOKBACK_HOURS || 24);
const THREAD_LOOKBACK_DAYS = Number(env.THREAD_LOOKBACK_DAYS || 7);
const WEEKDAYS_ONLY = env.WEEKDAYS_ONLY === 'true';
const POST_WHEN_EMPTY = env.POST_WHEN_EMPTY !== 'false';
const AUTO_JOIN_PUBLIC = env.AUTO_JOIN_PUBLIC === 'true';
// People whose individual @-mentions also go in the digest (matched by Slack name)
const OPS_PEOPLE = (env.OPS_PEOPLE ?? 'Kai, Gino, JB, Ivan Bernal')
  .split(',').map(s => s.trim().replace(/^@/, '')).filter(Boolean);

const TZ = 'Asia/Manila';
const SNIPPET_LENGTH = 300;
const MAX_BLOCKS = 48; // Slack allows 50 blocks per message
const SKIP_SUBTYPES = new Set([
  'channel_join', 'channel_leave', 'channel_topic',
  'channel_purpose', 'channel_name', 'channel_archive',
]);

const client = new WebClient(SLACK_BOT_TOKEN);
const userNames = new Map();
const groupHandles = new Map();
const targetLabels = new Map();
const setupWarnings = [];

// ---------- main ----------

async function main() {
  if (!SLACK_BOT_TOKEN || !DIGEST_CHANNEL_ID) {
    throw new Error('Set SLACK_BOT_TOKEN and DIGEST_CHANNEL_ID in Railway Variables.');
  }

  const { bot_id: ownBotId } = await client.auth.test();
  const targetIds = await resolveTargets();
  const range = getRange();
  console.log(`Looking for ${targetIds.join(', ')} over the last ${range.hours}h`);

  if (AUTO_JOIN_PUBLIC) await joinPublicChannels();

  const channels = (await getMemberChannels()).filter(c => c.id !== DIGEST_CHANNEL_ID);
  const seen = new Set();
  const hits = [];

  for (const channel of channels) {
    for (const hit of await scanChannel(channel, targetIds, range, ownBotId)) {
      const key = `${channel.id}:${hit.msg.ts}`;
      if (!seen.has(key)) {
        seen.add(key);
        hits.push(hit);
      }
    }
  }

  hits.sort((a, b) => Number(a.msg.ts) - Number(b.msg.ts));
  console.log(`Found ${hits.length} tagged message(s) across ${channels.length} channel(s)`);

  await postDigest(hits, range);
}

// ---------- setup ----------

async function resolveTargets() {
  const ids = [...EXTRA_TARGET_IDS];
  try {
    const { usergroups = [] } = await client.usergroups.list();
    for (const g of usergroups) groupHandles.set(g.id, g.handle);

    if (OPS_GROUP_HANDLE) {
      const wanted = OPS_GROUP_HANDLE.toLowerCase();
      const group = usergroups.find(
        g => g.handle.toLowerCase() === wanted || g.name.toLowerCase() === wanted
      );
      if (!group) {
        const available = usergroups.map(g => '@' + g.handle).join(', ') || 'none';
        throw new Error(`No user group "@${OPS_GROUP_HANDLE}". Groups in this workspace: ${available}`);
      }
      ids.push(group.id);
      targetLabels.set(group.id, '@' + group.handle);
    }
  } catch (err) {
    if (OPS_GROUP_HANDLE) throw err;
  }

  ids.push(...await resolvePeople());

  if (!ids.length) throw new Error('Nothing to look for: set OPS_GROUP_HANDLE or EXTRA_TARGET_IDS.');
  return ids;
}

// Match each name in OPS_PEOPLE to exactly one Slack user. Exact full/display name wins;
// otherwise a unique first-name match is used. Anything unclear is flagged in the digest.
async function resolvePeople() {
  if (!OPS_PEOPLE.length) return [];

  const members = [];
  for await (const page of client.paginate('users.list', { limit: 200 })) {
    members.push(...(page.members || []).filter(u => !u.deleted && !u.is_bot && u.id !== 'USLACKBOT'));
  }

  const norm = s => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const namesOf = u => [u.real_name, u.profile?.real_name, u.profile?.display_name, u.name].map(norm).filter(Boolean);

  const ids = [];
  for (const wanted of OPS_PEOPLE) {
    const w = norm(wanted);
    let matches = members.filter(u => namesOf(u).includes(w));
    if (!matches.length) matches = members.filter(u => namesOf(u).some(n => n.split(' ')[0] === w));

    if (matches.length === 1) {
      const u = matches[0];
      const label = u.real_name || u.profile?.display_name || u.name;
      ids.push(u.id);
      targetLabels.set(u.id, '@' + label);
      userNames.set(u.id, label);
      console.log(`"${wanted}" → ${label} (${u.id})`);
    } else if (matches.length > 1) {
      const options = matches.map(u => `${u.real_name || u.name} ${u.id}`).join(', ');
      setupWarnings.push(`"${wanted}" matches ${matches.length} people (${options}). Put the right ID in EXTRA_TARGET_IDS and remove the name from OPS_PEOPLE.`);
    } else {
      setupWarnings.push(`No one named "${wanted}" was found, so their tags aren't included.`);
    }
  }

  setupWarnings.forEach(w => console.warn(w));
  return ids;
}

function getRange() {
  const end = Date.now() / 1000;
  let hours = LOOKBACK_HOURS;
  // On a weekdays-only schedule, Monday's digest also covers Saturday and Sunday
  if (WEEKDAYS_ONLY && weekdayInManila() === 'Mon') hours += 48;
  return { start: end - hours * 3600, end, hours };
}

function weekdayInManila() {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(new Date());
}

async function joinPublicChannels() {
  for await (const page of client.paginate('conversations.list', {
    types: 'public_channel', exclude_archived: true, limit: 200,
  })) {
    for (const ch of page.channels || []) {
      if (ch.is_member) continue;
      try {
        await client.conversations.join({ channel: ch.id });
      } catch (err) {
        console.warn(`Couldn't join #${ch.name}: ${err.data?.error || err.message}`);
      }
    }
  }
}

async function getMemberChannels() {
  const channels = [];
  for await (const page of client.paginate('users.conversations', {
    types: 'public_channel,private_channel', exclude_archived: true, limit: 200,
  })) {
    channels.push(...(page.channels || []));
  }
  return channels;
}

// ---------- scanning ----------

async function scanChannel(channel, targetIds, range, ownBotId) {
  const hits = [];
  // Look further back for thread parents so new replies in older threads are still caught
  const oldest = Math.min(range.start, range.end - THREAD_LOOKBACK_DAYS * 86400);

  try {
    for await (const page of client.paginate('conversations.history', {
      channel: channel.id, oldest: String(oldest), latest: String(range.end), limit: 200,
    })) {
      for (const msg of page.messages || []) {
        if (Number(msg.ts) >= range.start) {
          const matched = matchTargets(msg, targetIds, ownBotId);
          if (matched.length) hits.push({ channel, msg, matched });
        }
        if (msg.reply_count && Number(msg.latest_reply) >= range.start) {
          for (const reply of await getReplies(channel.id, msg.ts, range)) {
            const matched = matchTargets(reply, targetIds, ownBotId);
            if (matched.length) hits.push({ channel, msg: reply, matched, inThread: true });
          }
        }
      }
    }
  } catch (err) {
    console.warn(`Skipped #${channel.name}: ${err.data?.error || err.message}`);
  }

  return hits;
}

async function getReplies(channelId, threadTs, range) {
  const replies = [];
  for await (const page of client.paginate('conversations.replies', {
    channel: channelId, ts: threadTs, oldest: String(range.start), latest: String(range.end), limit: 200,
  })) {
    for (const m of page.messages || []) {
      if (m.ts !== threadTs && Number(m.ts) >= range.start) replies.push(m);
    }
  }
  return replies;
}

function matchTargets(msg, targetIds, ownBotId) {
  if (ownBotId && msg.bot_id === ownBotId) return [];
  if (SKIP_SUBTYPES.has(msg.subtype)) return [];
  const text = fullText(msg);
  return targetIds.filter(id =>
    id.startsWith('S') ? text.includes(`<!subteam^${id}`) : text.includes(`<@${id}`)
  );
}

function fullText(msg) {
  const parts = [msg.text || ''];
  for (const a of msg.attachments || []) parts.push(a.pretext, a.text, a.fallback);
  return parts.filter(Boolean).join('\n');
}

// ---------- posting ----------

async function postDigest(hits, range) {
  const dateLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric',
  }).format(new Date());
  const span = `the last ${range.hours} hours`;

  const warningText = setupWarnings.length ? `⚠️ ${setupWarnings.join('\n⚠️ ')}` : '';

  if (!hits.length) {
    if (POST_WHEN_EMPTY || warningText) {
      await client.chat.postMessage({
        channel: DIGEST_CHANNEL_ID,
        text: `✅ Operations digest for ${dateLabel}: no Ops tags in ${span}.${warningText ? '\n' + warningText : ''}`,
      });
    }
    return;
  }

  const byChannel = new Map();
  for (const h of hits) {
    if (!byChannel.has(h.channel.id)) byChannel.set(h.channel.id, []);
    byChannel.get(h.channel.id).push(h);
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `📋 Operations digest — ${dateLabel}` } },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `${plural(hits.length, 'message')} tagging Ops across ${plural(byChannel.size, 'channel')} in ${span}`,
      }],
    },
  ];
  if (warningText) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: warningText }] });
  }

  for (const channelHits of byChannel.values()) {
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*#${channelHits[0].channel.name}*` } });
    for (const h of channelHits) blocks.push(await renderHit(h));
  }

  const chunks = [];
  for (let i = 0; i < blocks.length; i += MAX_BLOCKS) chunks.push(blocks.slice(i, i + MAX_BLOCKS));

  const summary = `Operations digest: ${plural(hits.length, 'tagged message')} in ${span}`;
  const first = await client.chat.postMessage({
    channel: DIGEST_CHANNEL_ID, text: summary, blocks: chunks[0],
    unfurl_links: false, unfurl_media: false,
  });

  // Overflow goes into the thread of the first digest message
  for (const chunk of chunks.slice(1)) {
    await client.chat.postMessage({
      channel: DIGEST_CHANNEL_ID, thread_ts: first.ts, text: `${summary} (continued)`,
      blocks: chunk, unfurl_links: false, unfurl_media: false,
    });
  }
}

async function renderHit({ channel, msg, matched, inThread }) {
  const tagged = [];
  for (const id of matched) {
    tagged.push(targetLabels.get(id) ||
      (id.startsWith('S') ? `@${groupHandles.get(id) || 'group'}` : `@${await userName(id)}`));
  }
  const author = msg.user ? await userName(msg.user) : (msg.bot_profile?.name || msg.username || 'An app');
  const when = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(Number(msg.ts) * 1000));
  const snippet = quote(truncate(await cleanText(msg.text || fullText(msg))));

  let link = '';
  try {
    const { permalink } = await client.chat.getPermalink({ channel: channel.id, message_ts: msg.ts });
    link = `\n<${permalink}|${inThread ? 'View in thread' : 'View message'}>`;
  } catch {}

  return {
    type: 'section',
    text: { type: 'mrkdwn', text: `*${author}* · ${when}${inThread ? ' · thread reply' : ''} · tagged ${tagged.join(', ')}\n${snippet}${link}` },
  };
}

async function userName(id) {
  if (userNames.has(id)) return userNames.get(id);
  let name = 'Someone';
  try {
    const { user } = await client.users.info({ user: id });
    name = user.real_name || user.profile?.display_name || user.name;
  } catch {}
  userNames.set(id, name);
  return name;
}

// Turn mentions into plain text so the digest itself never pings anyone
async function cleanText(text) {
  const userRe = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;
  const ids = [...new Set([...text.matchAll(userRe)].map(m => m[1]))];
  for (const id of ids) await userName(id);

  return text
    .replace(userRe, (_, id) => `@${userNames.get(id)}`)
    .replace(/<!subteam\^([A-Z0-9]+)(?:\|@?([^>]*))?>/g, (_, id, label) => `@${label || groupHandles.get(id) || 'group'}`)
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
    .replace(/\n{3,}/g, '\n\n');
}

function truncate(text) {
  if (text.length <= SNIPPET_LENGTH) return text;
  let cut = text.slice(0, SNIPPET_LENGTH);
  const open = cut.lastIndexOf('<');
  if (open > cut.lastIndexOf('>')) cut = cut.slice(0, open); // don't break a link mid-way
  return cut.trimEnd() + '…';
}

function quote(text) {
  return text.split('\n').map(line => `> ${line}`).join('\n');
}

// ---------- run ----------

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
