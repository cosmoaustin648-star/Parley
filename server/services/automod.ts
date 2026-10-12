import { db, many } from '../db/index.ts';
import { HttpError } from '../http/router.ts';
import { getMember, basePermissions, invalidateMember } from './access.ts';
import { audit } from './audit.ts';
import { P, has } from '../../shared/permissions.ts';

export interface AutomodRule {
  id: string; server_id: string; name: string; enabled: boolean;
  trigger_type: 'keyword' | 'mention_spam' | 'links' | 'invites';
  config: { keywords?: string[]; allow?: string[]; limit?: number; allowed_domains?: string[] };
  action: 'block' | 'block_and_timeout'; timeout_seconds: number; exempt_role_ids: string[];
}

const cache = new Map<string, { rules: AutomodRule[]; at: number }>();
export const invalidateAutomod = (serverId: string) => cache.delete(serverId);

async function rulesFor(serverId: string) {
  const hit = cache.get(serverId);
  if (hit && Date.now() - hit.at < 60_000) return hit.rules;
  const rules = await many<AutomodRule>('SELECT * FROM automod_rules WHERE server_id = $1 AND enabled', [serverId]);
  cache.set(serverId, { rules, at: Date.now() });
  return rules;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Keywords support a leading/trailing `*` wildcard; otherwise they match whole words, case-insensitively. */
export function keywordMatcher(words: string[]) {
  const parts = words.map((w) => w.trim().toLowerCase()).filter(Boolean).slice(0, 1000).map((w) => {
    const pre = w.startsWith('*'), post = w.endsWith('*');
    const core = escapeRe(w.replace(/^\*|\*$/g, ''));
    return `${pre ? '' : '(?<![\\p{L}\\p{N}])'}${core}${post ? '' : '(?![\\p{L}\\p{N}])'}`;
  });
  if (!parts.length) return null;
  return new RegExp(parts.join('|'), 'iu');
}

const URL_RE = /\bhttps?:\/\/([^\s/?#<>]+)/gi;
const INVITE_RE = /(?:\/invite\/|parley\.gg\/)([A-Za-z0-9]{4,32})/i;

export function evaluateRule(rule: AutomodRule, content: string, mentionCount: number): string | null {
  switch (rule.trigger_type) {
    case 'keyword': {
      const re = keywordMatcher(rule.config.keywords ?? []);
      const m = re && content.match(re);
      if (!m) return null;
      const allowed = (rule.config.allow ?? []).map((s) => s.toLowerCase());
      return allowed.includes(m[0].toLowerCase()) ? null : `keyword "${m[0]}"`;
    }
    case 'mention_spam':
      return mentionCount > (rule.config.limit ?? 5) ? `${mentionCount} mentions` : null;
    case 'links': {
      const allowed = (rule.config.allowed_domains ?? []).map((d) => d.toLowerCase());
      for (const m of content.matchAll(URL_RE)) {
        const host = m[1].toLowerCase().split(':')[0];
        if (!allowed.some((d) => host === d || host.endsWith('.' + d))) return `link to ${host}`;
      }
      return null;
    }
    case 'invites':
      return INVITE_RE.test(content) ? 'invite link' : null;
  }
}

/** Throws if a message violates an enabled AutoMod rule. */
export async function enforceAutomod(serverId: string, channelId: string, userId: string, content: string, mentionCount: number) {
  const rules = await rulesFor(serverId);
  if (!rules.length) return;
  const perms = await basePermissions(serverId, userId);
  if (has(perms, P.MANAGE_SERVER) || has(perms, P.ADMINISTRATOR)) return; // managers are exempt
  const member = await getMember(serverId, userId);
  const roles = new Set(member?.roleIds ?? []);
  for (const rule of rules) {
    if (rule.exempt_role_ids.some((r) => roles.has(r))) continue;
    const hit = evaluateRule(rule, content, mentionCount);
    if (!hit) continue;
    await audit(serverId, null, 'automod_block', { type: 'user', id: userId }, `Rule "${rule.name}" (${hit})`, {
      rule_id: rule.id, channel_id: channelId, content: content.slice(0, 500),
    });
    if (rule.action === 'block_and_timeout' && rule.timeout_seconds > 0) {
      await db.query(`UPDATE server_members SET timeout_until = now() + make_interval(secs => $3) WHERE server_id = $1 AND user_id = $2`,
        [serverId, userId, rule.timeout_seconds]);
      invalidateMember(serverId, userId);
      await audit(serverId, null, 'automod_timeout', { type: 'user', id: userId }, `Rule "${rule.name}"`, { seconds: rule.timeout_seconds });
      const { syncServerToMembers } = await import('./state.ts');
      await syncServerToMembers(serverId, [userId]);
    }
    throw new HttpError(400, 'automod_blocked', `Your message was blocked by AutoMod (${rule.name}).`, { rule: rule.name });
  }
}
