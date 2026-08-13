import { describe, expect, it } from 'vitest';

import { goalChatIdFromHash } from '../src/dashboard/web/goals.js';

describe('goal dashboard deep-link filter', () => {
  it('accepts only the goals chatId query and decodes it', () => {
    expect(goalChatIdFromHash('#/goals?chatId=oc_goal%2Fone')).toBe('oc_goal/one');
    expect(goalChatIdFromHash('#/goals')).toBeUndefined();
    expect(goalChatIdFromHash('#/sessions?chatId=oc_goal')).toBeUndefined();
  });
});
