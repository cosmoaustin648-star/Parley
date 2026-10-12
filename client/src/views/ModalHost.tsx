import { useStore } from '../lib/store.ts';
import {
  CreateServerModal, InviteModal, CreateChannelModal, CreateCategoryModal, ConfirmModal, ReportModal, ModerateModal,
  ImageModal, NewDmModal, QuickSwitcher, ShortcutsModal, EditGroupModal, ThreadRedirect, ServerInfoModal,
} from './modals/Basic.tsx';
import { ProfileModal } from './modals/Profile.tsx';
import { ServerSettings } from './modals/ServerSettings.tsx';
import { ChannelSettings } from './modals/ChannelSettings.tsx';
import { UserSettings } from './modals/UserSettings.tsx';

export function ModalHost() {
  const m = useStore((s) => s.modal);
  if (!m) return null;
  switch (m.kind) {
    case 'createServer': return <CreateServerModal />;
    case 'invite': return <InviteModal serverId={m.serverId} />;
    case 'createChannel': return <CreateChannelModal serverId={m.serverId} categoryId={m.categoryId ?? null} type={m.type} />;
    case 'createCategory': return <CreateCategoryModal serverId={m.serverId} />;
    case 'confirm': return <ConfirmModal {...m} />;
    case 'report': return <ReportModal messageId={m.messageId} userId={m.userId} serverId={m.serverId} />;
    case 'moderate': return <ModerateModal action={m.action} serverId={m.serverId} user={m.user} />;
    case 'image': return <ImageModal url={m.url} name={m.name} />;
    case 'newDm': return <NewDmModal />;
    case 'quickSwitcher': return <QuickSwitcher />;
    case 'shortcuts': return <ShortcutsModal />;
    case 'editGroup': return <EditGroupModal channelId={m.channelId} />;
    case 'profile': return <ProfileModal userId={m.userId} serverId={m.serverId ?? null} />;
    case 'serverSettings': return <ServerSettings serverId={m.serverId} initialTab={m.tab} />;
    case 'channelSettings': return <ChannelSettings channelId={m.channelId} initialTab={m.tab} />;
    case 'userSettings': return <UserSettings initialTab={m.tab} />;
    case 'thread': return <ThreadRedirect channelId={m.channelId} />;
    case 'serverInfo': return <ServerInfoModal serverId={m.serverId} />;
  }
}
