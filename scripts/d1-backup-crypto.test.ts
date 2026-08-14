import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import {
  decryptD1Backup,
  encryptD1Backup,
  parseBackupEncryptionKey,
} from './d1-backup-crypto';

const temporaryDirectories: string[] = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'd1-backup-crypto-test-'));
  temporaryDirectories.push(path);
  return path;
}

describe('D1 backup encryption', () => {
  it('round-trips a SQL backup with AES-256-GCM', async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, 'source.sql');
    const encrypted = join(directory, 'backup.sql.enc');
    const restored = join(directory, 'restored.sql');
    const sql = 'CREATE TABLE messages (id TEXT PRIMARY KEY, body TEXT);\nINSERT INTO messages VALUES (\'1\', \'秘密の本文\');\n';
    const key = randomBytes(32);
    await writeFile(source, sql, { mode: 0o600 });

    await encryptD1Backup(source, encrypted, key);
    expect((await readFile(encrypted)).includes(Buffer.from('秘密の本文'))).toBe(false);
    await decryptD1Backup(encrypted, restored, key);

    expect(await readFile(restored, 'utf8')).toBe(sql);
    expect((await stat(encrypted)).mode & 0o777).toBe(0o600);
    expect((await stat(restored)).mode & 0o777).toBe(0o600);
  });

  it('rejects a wrong key without leaving partial plaintext', async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, 'source.sql');
    const encrypted = join(directory, 'backup.sql.enc');
    const restored = join(directory, 'restored.sql');
    await writeFile(source, 'SELECT 1;\n', { mode: 0o600 });
    await encryptD1Backup(source, encrypted, randomBytes(32));

    await expect(decryptD1Backup(encrypted, restored, randomBytes(32))).rejects.toThrow();
    await expect(stat(restored)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts only a canonical Base64-encoded 32-byte key', () => {
    const valid = randomBytes(32).toString('base64');
    expect(parseBackupEncryptionKey(valid)).toHaveLength(32);
    expect(() => parseBackupEncryptionKey(undefined)).toThrow(/設定されていません/);
    expect(() => parseBackupEncryptionKey('not-base64')).toThrow(/32バイト/);
    expect(() => parseBackupEncryptionKey(Buffer.alloc(16).toString('base64'))).toThrow(/32バイト/);
  });
});
