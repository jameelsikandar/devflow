import { describe, expect, it } from 'vitest';
import { requireTestDatabase } from './database-config';
const application = 'postgresql://app:secret@localhost:5433/devflow?schema=public';
describe('verification database isolation', () => {
  it('accepts a separate explicitly named test database', () => {
    expect(
      requireTestDatabase(application, 'postgresql://test:secret@localhost:5433/devflow_test')
        .pathname,
    ).toBe('/devflow_test');
  });
  it('rejects missing configuration and non-PostgreSQL URLs', () => {
    expect(() => requireTestDatabase(application, undefined)).toThrow('separate');
    expect(() => requireTestDatabase(undefined, 'postgresql://localhost/devflow_test')).toThrow();
    expect(() => requireTestDatabase(application, 'sqlite://localhost/devflow_test')).toThrow(
      'PostgreSQL',
    );
    expect(() => requireTestDatabase(application, 'invalid')).toThrow('valid');
  });
  it('requires a safe test database name, rather than a schema or URL suffix', () => {
    for (const path of [
      'devflow',
      'devflow?schema=devflow_test',
      'devflow_test/other_test',
      'bad%27name_test',
    ])
      expect(() => requireTestDatabase(application, `postgresql://localhost/${path}`)).toThrow(
        '_test',
      );
  });
  it('does not accept the application database via different credentials, host, or schema', () => {
    const source = 'postgresql://app:secret@localhost/devflow_test?schema=public';
    expect(() =>
      requireTestDatabase(
        source,
        'postgresql://tester:different@127.0.0.1/devflow_test?schema=tests',
      ),
    ).toThrow('different database');
  });
});
