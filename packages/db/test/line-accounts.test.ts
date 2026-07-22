import { describe, expect, it, vi } from 'vitest';
import { deactivateLineAccount } from '../src/line-accounts.js';

describe('deactivateLineAccount', () => {
  it('keeps the row and marks the account inactive', async () => {
    const run = vi.fn().mockResolvedValue({ success: true });
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn(() => ({ bind }));
    const db = { prepare } as unknown as D1Database;

    await deactivateLineAccount(db, 'account-1');

    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE line_accounts'));
    expect(prepare).not.toHaveBeenCalledWith(expect.stringContaining('DELETE'));
    expect(bind).toHaveBeenCalledWith(expect.any(String), 'account-1');
    expect(run).toHaveBeenCalledOnce();
  });
});
