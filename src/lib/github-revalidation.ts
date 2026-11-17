import { z } from 'zod';
export const revalidationMessages = {
  ACCESS_VALID: {
    state: 'VALID',
    title: 'Repository access verified',
    detail:
      'The checked account authenticated and has administrator permission on the configured active repository. This verifies metadata/admin evidence only, not every enrichment API permission, webhook registration, signatures or delivery.',
  },
  AUTHORIZATION_REJECTED: {
    state: 'AUTHORIZATION_REJECTED',
    title: 'Authorization rejected',
    detail:
      'GitHub rejected the credential. It may be revoked, expired or invalid; the response does not establish which. Review the checked OAuth account before retrying.',
  },
  REPOSITORY_NOT_VISIBLE: {
    state: 'INACCESSIBLE',
    title: 'Repository not visible',
    detail:
      'The account authenticated, but the repository is missing or inaccessible to it. GitHub does not distinguish those cases here.',
  },
  REPOSITORY_ACCESS_BLOCKED: {
    state: 'INACCESSIBLE',
    title: 'Repository access blocked',
    detail:
      'GitHub blocked repository access. Review organization authorization and access policy; this does not prove that the credential was revoked.',
  },
  REPOSITORY_IDENTITY_CHANGED: {
    state: 'INACCESSIBLE',
    title: 'Repository identity differs',
    detail:
      'The returned repository ID or name differs from the configured identity. Nothing was retargeted. Investigate a rename, transfer or replaced repository manually.',
  },
  REPOSITORY_INACTIVE: {
    state: 'INACCESSIBLE',
    title: 'Repository inactive',
    detail:
      'GitHub reports this repository archived or disabled. The DevFlow connection remains unchanged.',
  },
  REPOSITORY_PERMISSION_INSUFFICIENT: {
    state: 'INSUFFICIENT_PERMISSION',
    title: 'Administrator permission missing',
    detail:
      'GitHub explicitly reported that the checked account lacks repository administrator permission. Review its repository access.',
  },
  PERMISSION_EVIDENCE_MISSING: {
    state: 'INCONCLUSIVE',
    title: 'Permission evidence unavailable',
    detail:
      'The repository is visible, but GitHub did not provide administrator-permission evidence. Access was not assumed valid.',
  },
  ACCOUNT_IDENTITY_UNCONFIRMED: {
    state: 'INCONCLUSIVE',
    title: 'Account identity differs',
    detail:
      'The GitHub login differs from the stored OAuth account login. Review the account connection; no credential or account identity was changed.',
  },
  OTHER_ENRICHMENT_AUTHORIZER: {
    state: 'INCONCLUSIVE',
    title: 'Authorizing administrator required',
    detail:
      'Configured enrichment uses another administrator’s authorization. Ask that administrator to run this check. Their credential was not used.',
  },
  ENRICHMENT_AUTHORIZATION_INCOMPLETE: {
    state: 'INCONCLUSIVE',
    title: 'Enrichment authorization incomplete',
    detail:
      'The configured enrichment grant is incomplete. Review its authorization settings explicitly; no fallback credential was used.',
  },
  OAUTH_ACCOUNT_MISSING: {
    state: 'NOT_CONFIGURED',
    title: 'OAuth account unavailable',
    detail:
      'The checked administrator has no stored GitHub OAuth account. This is not evidence of revocation. Connect an account explicitly before retrying.',
  },
  CREDENTIALS_UNREADABLE: {
    state: 'INCONCLUSIVE',
    title: 'Credential could not be read',
    detail:
      'Check server-side token encryption configuration. No credential was rotated or replaced.',
  },
  INVALID_CONNECTION_IDENTITY: {
    state: 'INCONCLUSIVE',
    title: 'Configured identity cannot be checked',
    detail:
      'The stored repository identity cannot be safely requested. Review connection configuration without automatically retargeting it.',
  },
  GITHUB_RATE_LIMITED: {
    state: 'INCONCLUSIVE',
    title: 'GitHub rate limited this check',
    detail:
      'A conclusive check could not finish. Retry only after the supplied deadline, if present. No automatic retry is scheduled.',
  },
  AUTHORIZATION_COOLDOWN: {
    state: 'INCONCLUSIVE',
    title: 'Recorded cooldown active',
    detail:
      'A local cooldown for this credential is still active. Wait until its recorded deadline. No GitHub request was made by this check.',
  },
  GITHUB_UNAVAILABLE: {
    state: 'INCONCLUSIVE',
    title: 'GitHub check unavailable',
    detail:
      'A network, provider or policy response prevented a conclusive check. Inspect service availability and try again explicitly.',
  },
  GITHUB_RESPONSE_UNRECOGNIZED: {
    state: 'INCONCLUSIVE',
    title: 'GitHub response not recognized',
    detail:
      'The response lacked the evidence required to validate access. No connection settings were changed.',
  },
  CONTEXT_CHANGED: {
    state: 'INCONCLUSIVE',
    title: 'Authorization context changed',
    detail:
      'Connection settings or credentials changed during the check. Discard this result and explicitly check the current configuration again.',
  },
  CONNECTION_DISCONNECTED: {
    state: 'DISCONNECTED',
    title: 'Connection disconnected',
    detail: 'This repository connection is disconnected. Revalidation never reconnects it.',
  },
  PROJECT_ARCHIVED: {
    state: 'PROJECT_ARCHIVED',
    title: 'Project archived',
    detail:
      'The project is archived. No valid access result is published and no configuration was changed.',
  },
} as const;
export type RevalidationCode = keyof typeof revalidationMessages;
export const revalidationSchema = z
  .object({
    scope: z.object({ workspaceId: z.string(), projectId: z.string(), connectionId: z.string() }),
    checkedAt: z.string().datetime({ offset: true }),
    authorizationSource: z.enum(['CONFIGURED_ENRICHMENT', 'REQUESTING_ADMIN', 'NONE']),
    state: z.enum([
      'VALID',
      'AUTHORIZATION_REJECTED',
      'INACCESSIBLE',
      'INSUFFICIENT_PERMISSION',
      'INCONCLUSIVE',
      'NOT_CONFIGURED',
      'DISCONNECTED',
      'PROJECT_ARCHIVED',
    ]),
    code: z.enum(Object.keys(revalidationMessages) as [RevalidationCode, ...RevalidationCode[]]),
    retryAt: z.string().datetime({ offset: true }).nullable(),
    retrySource: z.enum(['PROVIDER_HEADER', 'LOCAL_COOLDOWN']).nullable(),
  })
  .refine(
    (value) =>
      revalidationMessages[value.code].state === value.state &&
      (value.retryAt === null) === (value.retrySource === null),
    'Inconsistent revalidation evidence',
  );
export type RevalidationResult = z.infer<typeof revalidationSchema>;
