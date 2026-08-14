#!/usr/bin/env tsx

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import {
  chmod,
  open,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { argv, env, stderr, stdout } from 'node:process';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const MAGIC = Buffer.from('LLD1BK01', 'ascii');
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + IV_BYTES;

export function parseBackupEncryptionKey(rawKey: string | undefined): Buffer {
  const normalized = rawKey?.trim() ?? '';
  if (!normalized) {
    throw new Error('D1_BACKUP_ENCRYPTION_KEYが設定されていません');
  }
  const key = Buffer.from(normalized, 'base64');
  if (key.length !== 32 || key.toString('base64') !== normalized) {
    throw new Error('D1_BACKUP_ENCRYPTION_KEYは32バイトをBase64化した値にしてください');
  }
  return key;
}

function assertDifferentPaths(inputPath: string, outputPath: string): void {
  if (resolve(inputPath) === resolve(outputPath)) {
    throw new Error('入力ファイルと出力ファイルは別のパスにしてください');
  }
}

async function assertNonEmptyFile(path: string): Promise<number> {
  const file = await stat(path);
  if (!file.isFile() || file.size <= 0) {
    throw new Error('入力バックアップが空です');
  }
  return file.size;
}

export async function encryptD1Backup(
  inputPath: string,
  outputPath: string,
  key: Buffer,
): Promise<void> {
  assertDifferentPaths(inputPath, outputPath);
  await assertNonEmptyFile(inputPath);
  if (key.length !== 32) throw new Error('暗号鍵は32バイトである必要があります');

  const iv = randomBytes(IV_BYTES);
  const header = Buffer.concat([MAGIC, iv]);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);

  try {
    await writeFile(outputPath, header, { flag: 'wx', mode: 0o600 });
    await pipeline(
      createReadStream(inputPath),
      cipher,
      createWriteStream(outputPath, { flags: 'a', mode: 0o600 }),
    );
    const handle = await open(outputPath, 'a');
    try {
      await handle.write(cipher.getAuthTag());
    } finally {
      await handle.close();
    }
    await chmod(outputPath, 0o600);
  } catch (error) {
    await rm(outputPath, { force: true });
    throw error;
  }
}

export async function decryptD1Backup(
  inputPath: string,
  outputPath: string,
  key: Buffer,
): Promise<void> {
  assertDifferentPaths(inputPath, outputPath);
  const encryptedBytes = await assertNonEmptyFile(inputPath);
  if (key.length !== 32) throw new Error('復号鍵は32バイトである必要があります');
  if (encryptedBytes <= HEADER_BYTES + AUTH_TAG_BYTES) {
    throw new Error('暗号化バックアップの形式が不正です');
  }

  const handle = await open(inputPath, 'r');
  const header = Buffer.alloc(HEADER_BYTES);
  const authTag = Buffer.alloc(AUTH_TAG_BYTES);
  try {
    const headerRead = await handle.read({ buffer: header, position: 0 });
    const tagRead = await handle.read({
      buffer: authTag,
      position: encryptedBytes - AUTH_TAG_BYTES,
    });
    if (headerRead.bytesRead !== HEADER_BYTES || tagRead.bytesRead !== AUTH_TAG_BYTES) {
      throw new Error('暗号化バックアップを最後まで読み取れませんでした');
    }
  } finally {
    await handle.close();
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('暗号化バックアップの識別子が不正です');
  }

  const iv = header.subarray(MAGIC.length);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(header);
  decipher.setAuthTag(authTag);

  try {
    await pipeline(
      createReadStream(inputPath, {
        start: HEADER_BYTES,
        end: encryptedBytes - AUTH_TAG_BYTES - 1,
      }),
      decipher,
      createWriteStream(outputPath, { flags: 'wx', mode: 0o600 }),
    );
    await chmod(outputPath, 0o600);
  } catch (error) {
    await rm(outputPath, { force: true });
    throw error;
  }
}

function printHelp(): void {
  stdout.write('Usage: pnpm tsx scripts/d1-backup-crypto.ts <encrypt|decrypt> <input> <output>\n');
}

async function main(rawArgs: string[]): Promise<void> {
  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    printHelp();
    return;
  }
  const [operation, inputPath, outputPath, ...extra] = rawArgs;
  if ((operation !== 'encrypt' && operation !== 'decrypt') || !inputPath || !outputPath || extra.length > 0) {
    throw new Error('引数が不正です');
  }
  const key = parseBackupEncryptionKey(env.D1_BACKUP_ENCRYPTION_KEY);
  try {
    if (operation === 'encrypt') {
      await encryptD1Backup(inputPath, outputPath, key);
      stdout.write('D1バックアップを暗号化しました\n');
      return;
    }
    await decryptD1Backup(inputPath, outputPath, key);
    stdout.write('D1バックアップを復号しました\n');
  } finally {
    key.fill(0);
  }
}

const isCliEntry = argv[1]
  ? fileURLToPath(import.meta.url) === resolve(argv[1])
  : false;

if (isCliEntry) {
  process.umask(0o077);
  main(argv.slice(2)).catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : '不明なエラー';
    stderr.write(`D1バックアップ暗号処理を中断しました: ${reason}\n`);
    process.exitCode = 1;
  });
}
