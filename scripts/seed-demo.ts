/**
 * Demo data for showing Parley off. Everything created here is flagged with
 * `is_demo = true` (users and the server) and shown with a "Demo" badge in the
 * UI. Demo accounts get random passwords nobody knows, so they can't sign in.
 *
 *   npm run seed:demo            # create (idempotent)
 *   npm run seed:demo -- --remove  # delete all demo data
 */
import crypto from 'node:crypto';
import { db, one } from '../server/db/index.ts';
import { migrate } from '../server/db/migrate.ts';
import { hashPassword } from '../server/lib/crypto.ts';
import { DEFAULT_EVERYONE, DEFAULT_MODERATOR, P } from '../shared/permissions.ts';

const remove = process.argv.includes('--remove');
await migrate(db, () => {});

if (remove) {
  await db.query('DELETE FROM servers WHERE is_demo');
  const r = await db.query('DELETE FROM users WHERE is_demo');
  console.log(`[demo] removed demo server and ${r.rowCount} demo users`);
  await db.end();
  process.exit(0);
}

if (await one('SELECT 1 FROM servers WHERE is_demo')) {
  console.log('[demo] demo data already exists (use --remove first to recreate)');
  await db.end();
  process.exit(0);
}

const people = [
  { username: 'demo_ada', display: 'Ada Okafor', bio: 'Organises the study sessions. Ask me about spaced repetition.', status: 'Reviewing flashcards', color: '#2F6FD6' },
  { username: 'demo_kofi', display: 'Kofi Mensah', bio: 'Physics, chess, bad puns.', status: null, color: '#D64541' },
  { username: 'demo_lin', display: 'Lin Zhou', bio: 'Design student. Mostly here for #show-and-tell.', status: 'Sketching', color: '#3DBE8B' },
  { username: 'demo_rui', display: 'Rui Costa', bio: 'Moderator. Be kind, cite sources.', status: null, color: '#C9971C' },
  { username: 'demo_sam', display: 'Sam Rivera', bio: '', status: null, color: '#7A5CC9' },
];

const ids: Record<string, string> = {};
for (const p of people) {
  const u = await one(
    `INSERT INTO users (username, display_name, email, password_hash, email_verified_at, bio, custom_status, accent_color, is_demo)
     VALUES ($1,$2,$3,$4, now(), $5,$6,$7, true) RETURNING id`,
    [p.username, p.display, `${p.username}@demo.invalid`, await hashPassword(crypto.randomBytes(24).toString('hex')), p.bio, p.status, p.color]);
  ids[p.username] = u.id;
}

const server = await one(
  `INSERT INTO servers (name, owner_id, description, rules, is_public, is_demo) VALUES ($1,$2,$3,$4,true,true) RETURNING id`,
  ['Harbor Study Club (demo)', ids.demo_ada, 'A sample community to explore Parley: channels, threads, roles and voice rooms. The people here are demo accounts.',
    '1. Be kind and assume good faith.\n2. Keep homework help in #study-hall.\n3. No spoilers outside ||spoiler tags||.\n4. Moderators have the final say.']);
const sid = server.id;
const everyone = await one(`INSERT INTO roles (server_id, name, position, permissions, is_default) VALUES ($1,'@everyone',0,$2,true) RETURNING id`, [sid, DEFAULT_EVERYONE]);
const tutor = await one(`INSERT INTO roles (server_id, name, color, position, permissions, hoist, mentionable) VALUES ($1,'Tutor','#5B9BF0',1,$2,true,true) RETURNING id`, [sid, P.MANAGE_MESSAGES]);
const mod = await one(`INSERT INTO roles (server_id, name, color, position, permissions, hoist, mentionable) VALUES ($1,'Moderator','#3DBE8B',2,$2,true,true) RETURNING id`, [sid, DEFAULT_MODERATOR]);
await one(`INSERT INTO roles (server_id, name, color, position, permissions, hoist) VALUES ($1,'Admin','#F5C542',3,$2,true) RETURNING id`, [sid, P.ADMINISTRATOR]);
void everyone;

for (const u of Object.values(ids)) await db.query('INSERT INTO server_members (server_id, user_id) VALUES ($1,$2)', [sid, u]);
await db.query('INSERT INTO member_roles (server_id, user_id, role_id) VALUES ($1,$2,$3), ($1,$4,$5), ($1,$6,$5)', [sid, ids.demo_rui, mod.id, ids.demo_kofi, tutor.id, ids.demo_lin]);

const info = await one(`INSERT INTO categories (server_id, name, position) VALUES ($1,'Information',0) RETURNING id`, [sid]);
const talk = await one(`INSERT INTO categories (server_id, name, position) VALUES ($1,'Talk',1) RETURNING id`, [sid]);
const rooms = await one(`INSERT INTO categories (server_id, name, position) VALUES ($1,'Study rooms',2) RETURNING id`, [sid]);
const ch = async (name: string, cat: string, type: 'text' | 'voice', pos: number, topic = '') =>
  (await one(`INSERT INTO channels (server_id, category_id, type, name, topic, position) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [sid, cat, type, name, topic, pos])).id as string;
const welcome = await ch('welcome', info.id, 'text', 0, 'Start here. Rules are in Server settings.');
const general = await ch('general', talk.id, 'text', 0, 'Anything goes (within the rules).');
const study = await ch('study-hall', talk.id, 'text', 1, 'Ask questions, share resources, post your goals for the day.');
const show = await ch('show-and-tell', talk.id, 'text', 2, 'Share what you made this week.');
await ch('Quiet focus', rooms.id, 'voice', 0);
await ch('Group study', rooms.id, 'voice', 1);
await db.query(`INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny) VALUES ($1,'role',$2,0,$3)`, [welcome, everyone.id, P.SEND_MESSAGES]);
await db.query('UPDATE servers SET system_channel_id = $1 WHERE id = $2', [general, sid]);

let minutes = 60 * 26;
async function say(channel: string, who: string, content: string, extra: { reply?: string; pinned?: boolean } = {}) {
  minutes -= 3 + Math.floor(Math.random() * 20);
  const m = await one(
    `INSERT INTO messages (channel_id, author_id, content, reply_to_id, pinned, created_at, mention_user_ids)
     VALUES ($1,$2,$3,$4,$5, now() - make_interval(mins => $6), $7) RETURNING id`,
    [channel, ids[who], content, extra.reply ?? null, extra.pinned ?? false, minutes, [...content.matchAll(/<@(\d+)>/g)].map((x) => x[1])]);
  await db.query('UPDATE channels SET last_message_id = $1 WHERE id = $2', [m.id, channel]);
  return m.id as string;
}
const react = (mid: string, who: string[], emoji: string) => Promise.all(who.map((w) => db.query('INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1,$2,$3)', [mid, ids[w], emoji])));

const w1 = await say(welcome, 'demo_ada', "# Welcome aboard\nThis is a **demo server** that shows what Parley can do. Everyone you see here is a sample account.\n\n- Say hi in <#" + general + ">\n- Homework questions go in <#" + study + ">\n- Hop into a voice room to study together", { pinned: true });
await react(w1, ['demo_kofi', 'demo_lin', 'demo_rui'], '👋');
const g1 = await say(general, 'demo_kofi', 'Morning all. Anyone else still recovering from the thermodynamics quiz?');
await say(general, 'demo_lin', 'Recovering is a strong word. I am *coping*.', { reply: g1 });
const g3 = await say(general, 'demo_rui', 'Reminder: group study in the voice room tonight at 7. Bring one question you got stuck on.');
await react(g3, ['demo_ada', 'demo_sam'], '👍');
await say(general, 'demo_sam', 'Will be there. Is it okay to just listen in the first time?');
await say(general, 'demo_ada', `Of course <@${ids.demo_sam}>, lots of people do. Mute is the microphone button bottom-left.`);
const s1 = await say(study, 'demo_sam', 'Can someone explain why entropy always increases? My notes just say "it does".');
const s2 = await say(study, 'demo_kofi', 'Short version: there are vastly more disordered arrangements than ordered ones, so random changes almost always land in a more disordered state.\n```py\n# toy model: 100 coins, count arrangements with k heads\nfrom math import comb\nprint(comb(100, 50), comb(100, 0))\n```', { reply: s1 });
await react(s2, ['demo_sam', 'demo_ada', 'demo_lin'], '🔥');
const threadOwner = await one(`INSERT INTO channels (server_id, parent_channel_id, type, name, owner_id) VALUES ($1,$2,'thread','Entropy follow-ups',$3) RETURNING id`, [sid, study, ids.demo_kofi]);
await db.query('UPDATE messages SET thread_id = $1 WHERE id = $2', [threadOwner.id, s2]);
await say(threadOwner.id, 'demo_sam', 'So it is about probability, not a law that forces things?');
await say(threadOwner.id, 'demo_kofi', 'Exactly. It *could* decrease, it is just absurdly unlikely for anything big.');
await say(study, 'demo_ada', '> 25 minutes on, 5 off\nWho is in for a pomodoro round at 3?');
const sh1 = await say(show, 'demo_lin', 'Finished the poster for the robotics fair. Feedback welcome, especially on the type ||I am not sure about the serif||');
await react(sh1, ['demo_ada', 'demo_rui', 'demo_kofi', 'demo_sam'], '❤️');
await say(show, 'demo_rui', 'The hierarchy reads really clearly from across a room. Ship it.', { reply: sh1 });

console.log(`[demo] created "Harbor Study Club (demo)" (id ${sid}) with ${people.length} demo users. It's public, so anyone can join from Discover.`);
await db.end();
