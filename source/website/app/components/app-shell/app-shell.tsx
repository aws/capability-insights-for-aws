import { useState } from 'react';
import { useMatches } from 'react-router';
import type { RouteHandle } from '~/types/route';
import TopNavigation from '@cloudscape-design/components/top-navigation';
import AppLayout, { type AppLayoutProps } from '@cloudscape-design/components/app-layout';
import BreadcrumbGroup from '@cloudscape-design/components/breadcrumb-group';
import SideNavigation from '@cloudscape-design/components/side-navigation';
import {
  APP_NAME,
  PAGE_CAPABILITY_BY_REGION,
  PAGE_REGION_COMPARE,
  PAGE_POLICY_ENFORCER,
  PAGE_SETTINGS,
  CHAT_DRAWER_NAME,
  AWS_CAPABILITY_EXTERNAL,
  AWS_CAPABILITY_EXTERNAL_URL,
} from '~/constants/app';
import { useFeatureFlags } from '~/hooks/use-feature-flags';
import HelpMenu from './help-menu';
import ChatDrawer from '~/components/chat/chat-drawer';
import Footer from './footer';

const HELP_DRAWER_ID = 'help-panel';
const CHAT_DRAWER_ID = 'chat-panel';

/** The main content pane: route content, then the footer. */
function MainContent({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <Footer />
    </>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);
  const [activeDrawerId, setActiveDrawerId] = useState<string | null>(null);
  const matches = useMatches();
  const handle = matches.at(-1)?.handle as RouteHandle | undefined;
  const pageName = handle?.pageName ?? '';
  const extraCrumbs = handle?.breadcrumbs ?? [];

  // Chat is an opt-in feature; only surface the Assistant companion drawer when
  // its stack is deployed. When off, keep the original single-Help-panel layout
  // untouched (zero behavior change for existing deployments).
  const { state: featureFlagsState } = useFeatureFlags();
  const chatEnabled = featureFlagsState.status === 'ready' && featureFlagsState.flags.chat?.enabled === true;

  // Companion experience: the Assistant is a right-side drawer that overlays the
  // current page (Help + Assistant via the AppLayout `drawers` API). The drawer
  // stacks a sticky answer canvas above the conversation, so the definitive
  // answer refreshes in place without leaving the page you're on.
  const drawers: AppLayoutProps.Drawer[] | undefined = chatEnabled
    ? [
        {
          id: HELP_DRAWER_ID,
          ariaLabels: { drawerName: 'Help' },
          trigger: { iconName: 'status-info' },
          content: <HelpMenu />,
        },
        {
          id: CHAT_DRAWER_ID,
          ariaLabels: { drawerName: CHAT_DRAWER_NAME },
          trigger: { iconName: 'gen-ai' },
          resizable: true,
          defaultSize: 520,
          preserveInactiveContent: true,
          content: <ChatDrawer pageName={pageName} />,
        },
      ]
    : undefined;

  return (
    <>
      <div id="top-nav">
        <TopNavigation
          identity={{ href: '/', title: APP_NAME }}
          utilities={[
            {
              type: 'button',
              text: AWS_CAPABILITY_EXTERNAL,
              href: AWS_CAPABILITY_EXTERNAL_URL,
              external: true,
            },
          ]}
        />
      </div>
      <AppLayout
        maxContentWidth={Number.MAX_VALUE}
        navigationOpen={navOpen}
        onNavigationChange={({ detail }) => setNavOpen(detail.open)}
        breadcrumbs={
          <BreadcrumbGroup items={[{ text: APP_NAME, href: '/' }, ...extraCrumbs, { text: pageName, href: '' }]} />
        }
        navigation={
          <SideNavigation
            header={{ href: '/', text: APP_NAME }}
            items={[
              { type: 'link', text: PAGE_CAPABILITY_BY_REGION, href: '/' },
              { type: 'link', text: PAGE_REGION_COMPARE, href: '/region-compare' },
              {
                type: 'link',
                text: PAGE_POLICY_ENFORCER,
                href: '/policy-enforcer',
              },
              { type: 'link', text: PAGE_SETTINGS, href: '/settings' },
              { type: 'divider' },
              {
                type: 'link',
                text: AWS_CAPABILITY_EXTERNAL,
                href: AWS_CAPABILITY_EXTERNAL_URL,
                external: true,
              },
            ]}
          />
        }
        {...(chatEnabled
          ? {
              drawers,
              activeDrawerId,
              onDrawerChange: ({ detail }: { detail: { activeDrawerId: string | null } }) =>
                setActiveDrawerId(detail.activeDrawerId),
            }
          : { tools: <HelpMenu /> })}
        content={<MainContent>{children}</MainContent>}
      />
    </>
  );
}
