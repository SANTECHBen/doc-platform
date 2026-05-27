// One-shot CORS configuration for the R2 storage bucket.
//
// Symptom: browser-side audio (TTS voiceover, etc.) loads from the
// R2 public origin (pub-<hash>.r2.dev) on the admin and PWA domains
// throws CORS errors:
//   "No 'Access-Control-Allow-Origin' header is present on the
//    requested resource"
// because R2 public buckets ship CORS off by default. The S3-
// compatible PutBucketCors API is the way to fix that without
// migrating to a CORS-gated CDN.
//
// Audio + video elements with `crossorigin` or fetch()'d media all
// need the bucket to return ACAO for the requesting origin. The
// objects themselves don't contain secrets — keys are sha256 content-
// addressed and the bucket is already public — so wildcard origins
// are safe here.
//
// Run once per environment from the monorepo root:
//   S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com \
//   S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
//   S3_BUCKET=<bucket> \
//     pnpm -F @platform/api exec tsx scripts/set-r2-cors.ts
//
// Idempotent — PutBucketCors replaces the entire CORS configuration.

import {
  GetBucketCorsCommand,
  PutBucketCorsCommand,
  S3Client,
  type CORSRule,
} from '@aws-sdk/client-s3';

const endpoint = process.env.S3_ENDPOINT;
const region = process.env.S3_REGION ?? 'auto';
const accessKeyId = process.env.S3_ACCESS_KEY_ID;
const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
const bucket = process.env.S3_BUCKET;

if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
  console.error(
    'Missing required env: S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET',
  );
  process.exit(1);
}

const client = new S3Client({
  endpoint,
  region,
  credentials: { accessKeyId, secretAccessKey },
  // R2 (and MinIO) need path-style URLs.
  forcePathStyle: true,
});

// Wildcard read access — bucket is already public; this just unblocks
// the browser's same-origin check on cross-origin fetches. Limited to
// GET/HEAD because we don't expect browser-side writes (those go
// through the API via presigned URLs).
const rules: CORSRule[] = [
  {
    AllowedOrigins: ['*'],
    AllowedMethods: ['GET', 'HEAD'],
    // `*` covers Range, If-None-Match, etc. — the headers a media
    // element or fetch() request might send.
    AllowedHeaders: ['*'],
    // Range responses need these so the browser can interpret them.
    ExposeHeaders: ['Content-Range', 'Content-Length', 'ETag', 'Accept-Ranges'],
    // Browsers cache the preflight result for this long; 1h is the
    // sweet spot between churn and reasonable change propagation.
    MaxAgeSeconds: 3600,
  },
];

async function main() {
  console.log(`Setting CORS on bucket "${bucket}" (endpoint ${endpoint})…`);
  await client.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: { CORSRules: rules },
    }),
  );
  // Read it back so we can confirm the rule landed.
  const after = await client.send(
    new GetBucketCorsCommand({ Bucket: bucket }),
  );
  console.log('CORS now configured as:');
  console.log(JSON.stringify(after.CORSRules, null, 2));
}

main().catch((err) => {
  console.error('Failed to set CORS:', err);
  process.exit(1);
});
