import { type RouteConfig, index, route } from '@react-router/dev/routes';

export default [
  index('pages/capability-by-region.tsx'),
  route('policy-enforcer', 'pages/policy-enforcer.tsx'),
  route('policy-enforcer/create', 'pages/policy-enforcer-create.tsx'),
  route('policy-enforcer/:policyName', 'pages/policy-enforcer-detail.tsx'),
  route('settings', 'pages/settings.tsx'),
] satisfies RouteConfig;
