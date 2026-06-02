/** Analysis scope — single account or the entire AWS Organization. */
export const Scope = {
  ACCOUNT: 'account',
  ORGANIZATION: 'organization',
} as const;

export type Scope = (typeof Scope)[keyof typeof Scope];

export const VALID_SCOPES: Scope[] = [Scope.ACCOUNT, Scope.ORGANIZATION];
