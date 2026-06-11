import type { BreadcrumbGroupProps } from '@cloudscape-design/components/breadcrumb-group';

export interface RouteHandle {
  pageName: string;
  breadcrumbs?: BreadcrumbGroupProps.Item[];
}
