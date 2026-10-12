import { setState, getState, type Route } from './store.ts';

export function parseRoute(pathname: string, search: string): Route {
  const q = new URLSearchParams(search);
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] === 'login') return { name: 'login', next: q.get('next') || undefined };
  if (parts[0] === 'register') return { name: 'register', next: q.get('next') || undefined };
  if (parts[0] === 'forgot-password') return { name: 'forgot' };
  if (parts[0] === 'reset-password') return { name: 'reset', token: q.get('token') || '' };
  if (parts[0] === 'verify-email') return { name: 'verify', token: q.get('token') || '' };
  if (parts[0] === 'invite' && parts[1]) return { name: 'invite', code: parts[1] };
  if (parts[0] === 'discover') return { name: 'discover' };
  if (parts[0] === 'channels' && parts[1] === '@me') return { name: 'home', dmId: parts[2] };
  if (parts[0] === 'channels' && parts[1] && /^\d+$/.test(parts[1])) return { name: 'server', serverId: parts[1], channelId: parts[2] && /^\d+$/.test(parts[2]) ? parts[2] : undefined };
  return { name: 'home' };
}

export function routePath(r: Route): string {
  switch (r.name) {
    case 'login': return '/login' + (r.next ? `?next=${encodeURIComponent(r.next)}` : '');
    case 'register': return '/register' + (r.next ? `?next=${encodeURIComponent(r.next)}` : '');
    case 'forgot': return '/forgot-password';
    case 'reset': return `/reset-password?token=${r.token}`;
    case 'verify': return `/verify-email?token=${r.token}`;
    case 'invite': return `/invite/${r.code}`;
    case 'discover': return '/discover';
    case 'home': return r.dmId ? `/channels/@me/${r.dmId}` : '/channels/@me';
    case 'server': return `/channels/${r.serverId}${r.channelId ? '/' + r.channelId : ''}`;
  }
}

export function navigate(to: string | Route, replace = false) {
  const path = typeof to === 'string' ? to : routePath(to);
  if (path === location.pathname + location.search) return;
  if (replace) history.replaceState(null, '', path); else history.pushState(null, '', path);
  const route = parseRoute(location.pathname, location.search);
  setState((s) => ({ route, ui: { ...s.ui, mobileNav: false, mobileMembers: false, pinsOpen: false, threadId: s.ui.threadId && route.name === s.route.name ? null : null } }));
}

export function initRouter() {
  setState(() => ({ route: parseRoute(location.pathname, location.search) }));
  window.addEventListener('popstate', () => setState(() => ({ route: parseRoute(location.pathname, location.search) })));
}

export const currentRoute = () => getState().route;
