import { useState } from 'react';
import { useMatches } from 'react-router';
import type { RouteHandle } from '~/types/route';
import TopNavigation from '@cloudscape-design/components/top-navigation';
import AppLayout from '@cloudscape-design/components/app-layout';
import BreadcrumbGroup from '@cloudscape-design/components/breadcrumb-group';
import SideNavigation from '@cloudscape-design/components/side-navigation';
import {
  APP_NAME,
  PAGE_CAPABILITY_BY_REGION,
  PAGE_POLICY_ENFORCER,
  PAGE_SETTINGS,
  AWS_CAPABILITY_EXTERNAL,
  AWS_CAPABILITY_EXTERNAL_URL,
} from '~/constants/app';
import HelpMenu from './help-menu';
import Footer from './footer';

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);
  const matches = useMatches();
  const handle = matches.at(-1)?.handle as RouteHandle | undefined;
  const pageName = handle?.pageName ?? '';
  const extraCrumbs = handle?.breadcrumbs ?? [];
  return (
    <>
      <div id="top-nav">
        <TopNavigation
          identity={{
            href: '/',
            title: APP_NAME,
          }}
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
        tools={<HelpMenu />}
        content={
          <>
            {children}
            <Footer />
          </>
        }
      />
    </>
  );
}
