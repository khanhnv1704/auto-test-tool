/**
 * Claude models offered to the user, both for the default model (`aitest.generation.model`, changed
 * from the sidebar Settings section) and for the per-run choice in Sync Test (testCasesPanel.ts).
 * A fixed list rather than free text so the dropdown always shows valid choices. The ids are Claude
 * Code CLI aliases passed to `claude -p --model`, so they keep resolving to the latest model of each tier.
 */
export interface ModelOption {
  id: string;
  label: string;
}

export const MODEL_OPTIONS: ModelOption[] = [
  { id: 'haiku', label: 'Haiku (fast, low cost)' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'opus', label: 'Opus' }
];

/** Cheapest option; the default when `aitest.generation.model` has never been changed. */
export const DEFAULT_MODEL_ID = 'haiku';

/** Label for a model id; unknown ids (e.g. a full model id typed into settings.json) are shown as-is. */
export function getModelLabel(modelId: string): string {
  return MODEL_OPTIONS.find((m) => m.id === modelId)?.label ?? modelId;
}
