/* eslint-disable @typescript-eslint/no-require-imports -- Isolated CommonJS worker/preload tooling. */
'use strict';
// Loaded only in the isolated migration subprocess. No default .env discovery is
// allowed before filesystem/resource/environment validation and HTTP denial.
require('./guard.cjs').bootstrap();
