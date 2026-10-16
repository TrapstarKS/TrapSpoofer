import { z } from 'zod';

import { type AppConfig, useConfigStore } from '../stores/configStore';

export const idSchema = z.string().regex(/^[1-9]\d{0,19}$/, 'Expected a positive Roblox ID');
export const grantPermissionsSchema = z
  .object({
    enabled: z.boolean(),
    subjectType: z.enum(['Universe', 'Group', 'User']),
    ids: z.array(idSchema).max(100),
  })
  .strict()
  .refine((value) => !value.enabled || value.ids.length > 0, {
    message: 'Enabled permissions require at least one recipient ID',
  });
export type GrantPermissions = z.infer<typeof grantPermissionsSchema>;

const subjectTypes = { experience: 'Universe', group: 'Group', user: 'User' } as const;
const configSubjectTypes = { Universe: 'experience', Group: 'group', User: 'user' } as const;

export function configuredPermissions(config = useConfigStore.getState().config): GrantPermissions {
  return {
    enabled: config.permissions.enabled,
    subjectType: subjectTypes[config.permissions.subjectType],
    ids: config.permissions.subjectIds
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  };
}

export function permissionConfig(value: GrantPermissions): AppConfig['permissions'] {
  return {
    enabled: value.enabled,
    subjectType: configSubjectTypes[value.subjectType],
    subjectIds: value.ids.join(','),
    action: 'Use',
  };
}

export function getSettings() {
  const { config } = useConfigStore.getState();
  return {
    grantPermissions: configuredPermissions(config),
    skipOwned: config.advanced.skipOwned,
    keepNameAndDescription: config.spoofing.preserveMetadata,
    animationMode: config.spoofing.animationMode,
    enableArchiveRecovery: config.advanced.enableArchiveRecovery,
    autoPush: config.general.autoApplyResults,
  };
}

const settingsPatchSchema = z
  .object({
    grantPermissions: z
      .object({
        enabled: z.boolean().optional(),
        subjectType: z.enum(['Universe', 'Group', 'User']).optional(),
        ids: z.array(idSchema).max(100).optional(),
      })
      .strict()
      .optional(),
    skipOwned: z.boolean().optional(),
    keepNameAndDescription: z.boolean().optional(),
    animationMode: z
      .enum(['animation', 'clip_replace', 'clip_parent', 'clip_parent_id'])
      .optional(),
    enableArchiveRecovery: z.boolean().optional(),
    autoPush: z.boolean().optional(),
  })
  .strict();

export function updateSettings(args: unknown) {
  const patch = settingsPatchSchema.parse(args);
  const store = useConfigStore.getState();
  const permissions = patch.grantPermissions
    ? grantPermissionsSchema.parse({ ...configuredPermissions(), ...patch.grantPermissions })
    : undefined;
  if (permissions) store.updateCategory('permissions', permissionConfig(permissions));
  if (patch.skipOwned !== undefined) store.updateConfig('advanced', 'skipOwned', patch.skipOwned);
  if (patch.keepNameAndDescription !== undefined)
    store.updateConfig('spoofing', 'preserveMetadata', patch.keepNameAndDescription);
  if (patch.animationMode !== undefined)
    store.updateConfig('spoofing', 'animationMode', patch.animationMode);
  if (patch.enableArchiveRecovery !== undefined)
    store.updateConfig('advanced', 'enableArchiveRecovery', patch.enableArchiveRecovery);
  if (patch.autoPush !== undefined)
    store.updateConfig('general', 'autoApplyResults', patch.autoPush);
  return getSettings();
}
