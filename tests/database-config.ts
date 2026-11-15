/** Fail closed before test cleanup, migration or browser requests can touch application data. */
export function requireTestDatabase(
  applicationUrl: string | undefined,
  testUrl: string | undefined,
) {
  if (!applicationUrl || !testUrl)
    throw new Error(
      'Set DATABASE_URL and a separate TEST_DATABASE_URL whose database name ends in _test.',
    );
  let application: URL;
  let test: URL;
  try {
    application = new URL(applicationUrl);
    test = new URL(testUrl);
  } catch {
    throw new Error('Database URLs must be valid PostgreSQL URLs.');
  }
  if (![application, test].every((url) => ['postgres:', 'postgresql:'].includes(url.protocol)))
    throw new Error('Database URLs must use PostgreSQL.');
  const applicationName = decodeURIComponent(application.pathname.slice(1));
  const testName = decodeURIComponent(test.pathname.slice(1));
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*_test$/.test(testName))
    throw new Error(
      'The dedicated test database name must end in _test and contain only letters, digits and underscores.',
    );
  // Compare database names, not raw URLs: credentials, schema, host aliases and
  // connection options must not make the application database appear isolated.
  if (applicationName === testName)
    throw new Error('TEST_DATABASE_URL must name a different database from DATABASE_URL.');
  return test;
}
