// Evaluate tgcloud/schema.js the way the platform does at deploy time.
//
// The module is imported under the sdk loader: if any table() constraint
// callback throws (a missing import, a bad helper signature), the deploy fails
// with "Compilation failed". Here it fails the test suite instead.
import assert from 'node:assert/strict';
import { schemaErrors, assertSchemaCallbacksClean } from './sdk_db_stub.mjs';
import { quoteStickerPacks } from '../../tgcloud/schema.js';

assertSchemaCallbacksClean();
assert.equal(schemaErrors.length, 0, `constraint callbacks threw: ${JSON.stringify(schemaErrors.map((e) => e.table))}`);

// The pack table must be usable as a plain declaration.
assert.ok(quoteStickerPacks, 'quoteStickerPacks is exported');
assert.equal(quoteStickerPacks.__table, true);
assert.equal(quoteStickerPacks.tableName, 'quote_sticker_packs');
console.log('schema eval: OK');
