import { db, InputFile, BotApiError } from 'sdk';
import { api } from './message_api.js';
import { sql } from 'sdk/db';
import { OWNER_ID } from './config.js';
import { SOURCE_SNAPSHOT } from './source_snapshot.js';

const MAX_BYTES = 45 * 1024 * 1024; // stay under the 50 MB upload limit

// Manual UTF-8 encoder
function utf8(str) {
  const out = [];
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

// Blobs can't go into JSON directly, so store them as hex
function replacer(_k, v) {
  if (v instanceof Uint8Array) {
    return { __blob_hex: Array.from(v, (b) => b.toString(16).padStart(2, '0')).join('') };
  }
  return v;
}

async function dumpTables() {
  const metas = await db.all(
    sql`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
  );
  const tables = {};
  for (const m of metas) {
    if (!/^[A-Za-z0-9_]+$/.test(m.name)) continue; // safety: only plain names
    const rows = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await db.all(sql.raw(`SELECT * FROM "${m.name}" LIMIT 1000 OFFSET ${offset}`));
      rows.push(...page);
      if (page.length < 1000) break;
    }
    tables[m.name] = { create_sql: m.sql, row_count: rows.length, rows };
  }
  return tables;
}

export async function runBackup(requesterChatId) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    const tables = await dumpTables();
    const tableNames = Object.keys(tables);
    const full = utf8(JSON.stringify({ created: stamp, tables }, replacer, 2));

    if (full.length <= MAX_BYTES) {
      await api.sendDocument({
        chat_id: OWNER_ID,
        document: new InputFile(full, `backup-${stamp}.json`, { type: 'application/json' }),
        caption: `Database backup: ${tableNames.length} table(s)`,
      });
    } else {
      // Too big for one file: send one file per table, splitting if a table exceeds MAX_BYTES
      const failedTables = [];
      for (const [name, t] of Object.entries(tables)) {
        const tableJson = JSON.stringify({ table: name, create_sql: t.create_sql, row_count: t.row_count, rows: t.rows }, replacer, 2);
        const bytes = utf8(tableJson);
        if (bytes.length <= MAX_BYTES) {
          try {
            await api.sendDocument({
              chat_id: OWNER_ID,
              document: new InputFile(bytes, `backup-${stamp}-${name}.json`, { type: 'application/json' }),
              caption: `Database table: ${name} (${t.row_count} rows)`,
            });
          } catch (err) {
            console.error(`Failed to send backup for table ${name}:`, err);
            failedTables.push(name);
          }
        } else {
          // Table itself exceeds MAX_BYTES: split rows across numbered parts
          const partsCount = Math.ceil(bytes.length / (MAX_BYTES * 0.8));
          const rowsPerPart = Math.max(1, Math.floor(t.rows.length / partsCount));
          const totalParts = Math.ceil(t.rows.length / rowsPerPart);
          for (let part = 0; part < totalParts; part++) {
            const slice = t.rows.slice(part * rowsPerPart, (part + 1) * rowsPerPart);
            const partBytes = utf8(JSON.stringify({
              table: name,
              create_sql: t.create_sql,
              part: part + 1,
              total_parts: totalParts,
              chunk_row_count: slice.length,
              rows: slice,
            }, replacer, 2));
            try {
              await api.sendDocument({
                chat_id: OWNER_ID,
                document: new InputFile(partBytes, `backup-${stamp}-${name}-part${part + 1}.json`, { type: 'application/json' }),
                caption: `Table ${name} (part ${part + 1}/${totalParts}, ${slice.length} rows)`,
              });
            } catch (err) {
              console.error(`Failed to send part ${part + 1} for table ${name}:`, err);
              failedTables.push(`${name}-part${part + 1}`);
            }
          }
        }
      }
      if (failedTables.length > 0) {
        throw new Error(`Failed to upload ${failedTables.length} table backup file(s): ${failedTables.join(', ')}`);
      }
    }
    if (requesterChatId && requesterChatId !== OWNER_ID) {
      await notice(requesterChatId, 'Backup sent to your DM.');
    }
  } catch (e) {
    console.error('backup failed', e);
    const dmBlocked = e instanceof BotApiError && (e.code === 403 || e.code === 400);
    const msg = dmBlocked
      ? 'I cannot DM you. Open the bot privately and press Start first.'
      : `Backup failed: ${e?.message || 'Check logs'}`;
    try {
      await notice(requesterChatId || OWNER_ID, msg);
    } catch (_) {}
  }
}

// Status texts go out as rich messages; plain text only if Telegram refuses the rich one.
async function notice(chatId, text) {
  try {
    await api.sendRichMessage({
      chat_id: chatId,
      rich_message: { blocks: [{ type: 'paragraph', text }], skip_entity_detection: true },
    });
  } catch (e) {
    if (!(e instanceof BotApiError)) throw e;
    await api.sendMessage({ chat_id: chatId, text });
  }
}

// Sends a complete restorable snapshot of the project source code, config,
// project files and documentation. Refresh source_snapshot.js after changing
// project files, then redeploy. This does not read the runtime filesystem.
export async function runFullBackup(requesterChatId) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    const backupData = {
      format: 'tgcloud-source-snapshot-v1',
      created: stamp,
      note: 'Complete restorable project backup. Includes handlers, endpoints, libraries, configs, workflows, and documentation; excludes dependencies and secrets.',
      files: SOURCE_SNAPSHOT,
    };
    const bytes = utf8(JSON.stringify(backupData, null, 2));
    if (bytes.length > MAX_BYTES) {
      throw new Error(`Source backup size (${bytes.length} bytes) exceeds limit (${MAX_BYTES} bytes).`);
    }
    await api.sendDocument({
      chat_id: OWNER_ID,
      document: new InputFile(bytes, `project_full_backup-${stamp}.json`, { type: 'application/json' }),
      caption: `Full project backup: ${SOURCE_SNAPSHOT.length} file(s). Includes source code, configuration and documentation.`,
    });
    if (requesterChatId && requesterChatId !== OWNER_ID) {
      await notice(requesterChatId, 'Full project backup sent to your DM.');
    }
  } catch (e) {
    console.error('full source backup failed', e);
    const dmBlocked = e instanceof BotApiError && (e.code === 403 || e.code === 400);
    const msg = dmBlocked
      ? 'I cannot DM you. Open the bot privately and press Start first.'
      : `Full source backup failed: ${e?.message || 'Check logs'}`;
    try {
      await notice(requesterChatId || OWNER_ID, msg);
    } catch (_) {}
  }
}
