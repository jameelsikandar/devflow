import { afterEach, describe, expect, it } from 'vitest';
import {
  decrypt,
  digest,
  encrypt,
  hashPassword,
  token,
  verifyPassword,
} from '../src/lib/server/crypto';
const original = process.env.TOKEN_ENCRYPTION_KEY;
afterEach(() => {
  if (original === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
  else process.env.TOKEN_ENCRYPTION_KEY = original;
});
describe('authentication primitives', () => {
  it('salts passwords independently and verifies only the correct password', async () => {
    const first = await hashPassword('A secure password');
    const second = await hashPassword('A secure password');
    expect(first).not.toBe(second);
    expect(first).not.toContain('A secure password');
    expect(await verifyPassword('A secure password', first)).toBe(true);
    expect(await verifyPassword('wrong password', first)).toBe(false);
    expect(await verifyPassword('password', 'broken')).toBe(false);
  });
  it('issues unpredictable tokens and hashes stored session secrets', () => {
    const a = token();
    expect(a).toHaveLength(64);
    expect(token()).not.toBe(a);
    expect(digest(a)).not.toBe(a);
    expect(digest(a)).toHaveLength(64);
  });
});
describe('GitHub token encryption', () => {
  it('encrypts with random nonces and detects tampering', () => {
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    const a = encrypt('github-secret-token');
    const b = encrypt('github-secret-token');
    expect(a).not.toBe(b);
    expect(a).not.toContain('github-secret-token');
    expect(decrypt(a)).toBe('github-secret-token');
    const bits = a.split('.');
    bits[2] = (bits[2][0] === 'a' ? 'b' : 'a') + bits[2].slice(1);
    expect(() => decrypt(bits.join('.'))).toThrow();
  });
  it('fails closed without a valid encryption key', () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    expect(() => encrypt('token')).toThrow('TOKEN_ENCRYPTION_KEY');
    process.env.TOKEN_ENCRYPTION_KEY = 'short';
    expect(() => encrypt('token')).toThrow();
  });
});
