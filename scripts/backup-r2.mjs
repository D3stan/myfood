#!/usr/bin/env node
// Upload the newest local MyFood SQLite backup (gzipped) to Cloudflare R2 via S3v4 and prune old remote copies.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ENV_PATH = "/etc/myfood-backup.env";
const BACKUP_DIR = "/var/lib/myfood/backups";

function loadEnv(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const rfc3986 = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const sha256Hex = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

async function s3Request({ method, endpoint, bucket, keyPath = "", query = {}, body = null, headers = {}, accessKeyId, secretAccessKey }) {
  const url = new URL(endpoint);
  const encodedKey = keyPath
    ? "/" + keyPath.split("/").filter(Boolean).map(rfc3986).join("/")
    : "";
  const canonicalUri = `/${rfc3986(bucket)}${encodedKey}`;

  const queryEntries = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [rfc3986(k), rfc3986(String(v))])
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const canonicalQuery = queryEntries.map(([k, v]) => `${k}=${v}`).join("&");

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payload = body ?? Buffer.alloc(0);
  const payloadHash = sha256Hex(payload);

  const reqHeaders = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])),
  };

  const sortedHeaderKeys = Object.keys(reqHeaders).sort();
  const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${reqHeaders[k]}\n`).join("");
  const signedHeaders = sortedHeaderKeys.join(";");

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, "auto");
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const targetUrl = `${url.origin}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`;

  return fetch(targetUrl, {
    method,
    headers: { ...reqHeaders, authorization },
    body: body && body.length > 0 ? body : undefined,
  });
}

function findLatestBackup(explicitPath) {
  if (explicitPath) return explicitPath;
  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => /^myfood-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort()
    .reverse();
  if (files.length === 0) {
    throw new Error(`No backup files found in ${BACKUP_DIR}`);
  }
  return path.join(BACKUP_DIR, files[0]);
}

async function main() {
  const env = loadEnv(ENV_PATH);
  const endpoint = env.R2_ENDPOINT;
  const bucket = env.R2_BUCKET;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  const prefix = (env.R2_PREFIX || "myfood").replace(/^\/+|\/+$/g, "");
  const retentionDays = Number.parseInt(env.R2_RETENTION_DAYS || "30", 10);

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    console.error(
      `[myfood-backup-r2] Missing R2 configuration or credentials in ${ENV_PATH} (need R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY).`
    );
    process.exit(1);
  }

  const backupPath = findLatestBackup(process.argv[2]);
  const rawBuf = fs.readFileSync(backupPath);
  const gzBuf = zlib.gzipSync(rawBuf, { level: 9 });
  const objectKey = `${prefix}/${path.basename(backupPath)}.gz`;

  const putRes = await s3Request({
    method: "PUT",
    endpoint,
    bucket,
    keyPath: objectKey,
    body: gzBuf,
    headers: { "content-type": "application/gzip", "content-length": String(gzBuf.length) },
    accessKeyId,
    secretAccessKey,
  });
  if (!putRes.ok) {
    const errText = await putRes.text();
    throw new Error(`PUT ${objectKey} failed (${putRes.status}): ${errText}`);
  }

  const headRes = await s3Request({
    method: "HEAD",
    endpoint,
    bucket,
    keyPath: objectKey,
    accessKeyId,
    secretAccessKey,
  });
  if (!headRes.ok) {
    throw new Error(`HEAD verification failed for ${objectKey} (${headRes.status})`);
  }
  const remoteLen = Number(headRes.headers.get("content-length") || "0");
  if (remoteLen !== gzBuf.length) {
    throw new Error(`Size mismatch for ${objectKey}: uploaded ${gzBuf.length}, remote ${remoteLen}`);
  }
  console.log(`[myfood-backup-r2] Uploaded and verified s3://${bucket}/${objectKey} (${gzBuf.length} bytes gz, ${rawBuf.length} bytes raw)`);

  if (Number.isFinite(retentionDays) && retentionDays > 0) {
    const listRes = await s3Request({
      method: "GET",
      endpoint,
      bucket,
      query: { "list-type": "2", prefix: `${prefix}/` },
      accessKeyId,
      secretAccessKey,
    });
    if (!listRes.ok) {
      throw new Error(`List objects failed (${listRes.status}): ${await listRes.text()}`);
    }
    const xml = await listRes.text();
    const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)]
      .map((m) => m[1])
      .filter((k) => new RegExp(`^${escapedPrefix}/myfood-\\d{4}-\\d{2}-\\d{2}\\.db\\.gz$`).test(k))
      .sort()
      .reverse();

    const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString().slice(0, 10);
    for (const k of keys.slice(1)) {
      const m = k.match(/myfood-(\d{4}-\d{2}-\d{2})\.db\.gz$/);
      if (m && m[1] < cutoff) {
        const delRes = await s3Request({
          method: "DELETE",
          endpoint,
          bucket,
          keyPath: k,
          accessKeyId,
          secretAccessKey,
        });
        if (delRes.ok) {
          console.log(`[myfood-backup-r2] Pruned expired remote backup: ${k}`);
        } else {
          console.warn(`[myfood-backup-r2] Failed to prune ${k} (${delRes.status})`);
        }
      }
    }
  }
}

main().catch((err) => {
  console.error(`[myfood-backup-r2] ERROR: ${err.message}`);
  process.exit(1);
});
