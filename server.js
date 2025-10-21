import express from 'express';
import cors from 'cors';
import multer from 'multer';
import * as fs from 'node:fs';
import path from 'node:path';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { S3Client, PutObjectCommand, GetObjectCommand, CopyObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

/*
 * The Gargantuan backend – v1.6.0
 *
 * This server exposes a simple JSON API for publishing multimedia posts.  It
 * builds on top of the earlier “soft delete / bulk trash” release by
 * introducing Cloudflare R2 storage, support for text/image posts, drafts,
 * metadata handling and automatic audio‑to‑video generation.  All write
 * operations are protected by an admin token.  Files are temporarily
 * uploaded to the local `uploads/` folder and immediately written to
 * Cloudflare R2.  Metadata about every post lives in a single JSON file
 * (`posts/_meta.json`) stored in R2 alongside the media files.
 */

const app = express();
app.use(cors());
app.use(express.json());

// -----------------------------------------------------------------------------
// Configuration
//
// The following environment variables must be defined in your hosting
// environment (Render) in order for the backend to function correctly.  When
// not defined the server will gracefully fall back to default values for
// development purposes.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const S3_ENDPOINT = process.env.S3_ENDPOINT || '';
const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID || '';
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY || '';
const S3_BUCKET = process.env.S3_BUCKET || '';
const S3_PUBLIC_BASE = process.env.S3_PUBLIC_BASE || '';
const PORT = parseInt(process.env.PORT || '10000', 10);

// -----------------------------------------------------------------------------
// S3 / R2 client
//
// Cloudflare R2 is S3 compatible, so we use the AWS SDK v3 to talk to it.  The
// endpoint, access key and secret are all supplied via environment variables.
let s3Client = null;
if (S3_ENDPOINT && S3_BUCKET) {
  s3Client = new S3Client({
    region: 'auto',
    endpoint: S3_ENDPOINT,
    credentials: {
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_SECRET_ACCESS_KEY,
    },
  });
}

// -----------------------------------------------------------------------------
// Temporary upload directory
//
// Uploaded files and generated videos are stored briefly in the `uploads/`
// folder before being copied into R2.  The folder is created on demand.  If
// you run the server on Render the directory will persist only for the
// duration of the request.
const TEMP_DIR = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Configure multer to write files into the temp directory.  We rely on the
// incoming filename for its extension then normalise it with a timestamp to
// derive a unique post identifier.
const upload = multer({ dest: TEMP_DIR });

// Helper to require an admin token on write endpoints.  If no ADMIN_TOKEN is
// configured then all requests are allowed (useful for local development).
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  const provided = req.get('x-admin-token');
  if (provided !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// -----------------------------------------------------------------------------
// R2 helper functions
//
// These helpers wrap the AWS SDK to abstract away repetitive boilerplate.

// Convert a stream into a string; used for reading meta.json.
async function streamToString(stream) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

// Write a buffer or string to a key in R2.  The content type can be provided
// optionally; otherwise a generic binary type is assumed.
async function putObject(key, body, contentType = 'application/octet-stream') {
  if (!s3Client) return;
  await s3Client.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
}

// Read a key from R2 and return its contents as a string.  If the object
// doesn’t exist, return undefined rather than throwing.
async function getObject(key) {
  if (!s3Client) return undefined;
  try {
    const data = await s3Client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    return await streamToString(data.Body);
  } catch (err) {
    return undefined;
  }
}

// List objects under a prefix.  Returns an array of { Key, LastModified, Size }.
async function listObjects(prefix) {
  if (!s3Client) return [];
  const results = [];
  let ContinuationToken;
  do {
    const resp = await s3Client.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: prefix, ContinuationToken }));
    (resp.Contents || []).forEach((item) => results.push(item));
    ContinuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return results;
}

// Copy an object within the bucket.  Useful for moving into and out of the
// `.trash` folder.
async function copyObject(srcKey, dstKey) {
  if (!s3Client) return;
  await s3Client.send(new CopyObjectCommand({
    Bucket: S3_BUCKET,
    CopySource: `${S3_BUCKET}/${srcKey}`,
    Key: dstKey,
  }));
}

// Delete a key from R2.  No error is thrown if the key doesn’t exist.
async function deleteObject(key) {
  if (!s3Client) return;
  await s3Client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
}

// Download an object from R2 into a local file.  Returns the local path on
// success, or undefined if the object could not be retrieved.
async function downloadToTemp(key) {
  if (!s3Client) return undefined;
  try {
    const data = await s3Client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    const localPath = path.join(TEMP_DIR, path.basename(key));
    await new Promise((resolve, reject) => {
      const stream = fs.createWriteStream(localPath);
      data.Body.pipe(stream);
      stream.on('finish', resolve);
      stream.on('error', reject);
    });
    return localPath;
  } catch (err) {
    return undefined;
  }
}

// Compute a base URL for public objects.  When S3_PUBLIC_BASE is provided,
// constructed URLs will begin with that domain; otherwise a relative `/uploads`
// path is returned (useful when running locally).
function absoluteUrl(key) {
  if (S3_PUBLIC_BASE) return `${S3_PUBLIC_BASE}/${key}`;
  return `/uploads/${key}`;
}

// -----------------------------------------------------------------------------
// Metadata helpers
//
// We store post metadata in a single JSON file under `posts/_meta.json`.  Each
// entry is keyed by the base id (derived from the filename without extension).
async function readMeta() {
  const text = await getObject('posts/_meta.json');
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

async function writeMeta(meta) {
  await putObject('posts/_meta.json', JSON.stringify(meta, null, 2), 'application/json');
}

// Resolve the type of a post given the presence of audio/video files and
// metadata.  The order of precedence matches the specification: video > audio
// > image > text.
function determineType(hasVideo, hasAudio, metaEntry) {
  if (hasVideo) return 'video';
  if (hasAudio) return 'audio';
  if (metaEntry?.imageUrl) return 'image';
  return 'text';
}

// Build a post record from an id and the objects found in R2.  This helper
// computes the appropriate play URL, type, and merges metadata.  It returns
// undefined if the post is a draft and drafts are not requested.
async function buildPost(id, objs, meta, includeDrafts = false, isTrash = false) {
  const metaEntry = meta[id] || {};
  // Respect draft status: skip drafts unless explicitly requested.
  if (!includeDrafts && metaEntry.draft) return undefined;
  const hasAudio = objs.some(o => /\.mp3$/i.test(o.Key));
  const hasVideo = objs.some(o => /\.mp4$/i.test(o.Key));
  const audioUrl = hasAudio ? absoluteUrl(objs.find(o => /\.mp3$/i.test(o.Key)).Key) : '';
  const videoUrl = hasVideo ? absoluteUrl(objs.find(o => /\.mp4$/i.test(o.Key)).Key) : '';
  let date = objs.reduce((latest, o) => {
    const t = o.LastModified ? new Date(o.LastModified) : new Date();
    return !latest || t > latest ? t : latest;
  }, null);
  // If no objects provided (e.g. text/image post), derive date from id when
  // possible.  The id is a timestamp string (Date.now()), so parse it.
  if (!date) {
    const ts = parseInt(id, 10);
    if (!Number.isNaN(ts)) date = new Date(ts);
    else date = new Date();
  }
  return {
    id,
    title: metaEntry.title || id,
    body: metaEntry.body || '',
    imageUrl: metaEntry.imageUrl || '',
    draft: !!metaEntry.draft,
    type: determineType(hasVideo, hasAudio, metaEntry),
    playUrl: videoUrl || audioUrl || '',
    audioUrl,
    videoUrl,
    date: date.toISOString(),
    _trash: isTrash,
  };
}

// -----------------------------------------------------------------------------
// Routes

// Health & version endpoints.  These routes are unauthenticated and simply
// indicate that the backend is running.  The version endpoint returns the
// semantic version of the API.
app.get('/', (_req, res) => res.send('The Gargantuan backend is live.'));
app.get('/api/version', (_req, res) => res.json({ version: '1.6.0' }));
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/r2/health', async (_req, res) => {
  if (!s3Client) return res.json({ ok: true, enabled: false, count: 0 });
  try {
    const objects = await listObjects('posts/');
    res.json({ ok: true, enabled: true, count: objects.length });
  } catch (err) {
    res.status(500).json({ ok: false, enabled: true, error: String(err) });
  }
});

// List published posts.  This endpoint aggregates objects under `posts/` (but
// not under `.trash/`) and merges them with their metadata.  Only posts with
// `draft:false` are returned.
app.get('/api/posts', async (req, res) => {
  try {
    const meta = await readMeta();
    const objects = await listObjects('posts/');
    // Exclude trash entries.
    const filtered = objects.filter(o => !o.Key.startsWith('posts/.trash/'));
    // Group objects by base id.
    const groups = {};
    filtered.forEach((obj) => {
      const base = path.basename(obj.Key).replace(/\.[^/.]+$/, '');
      groups[base] = groups[base] || [];
      groups[base].push(obj);
    });
    // Ensure that posts with only metadata (no media objects) are included.
    Object.keys(meta).forEach((mid) => {
      if (mid.startsWith('_')) return;
      if (!groups[mid]) groups[mid] = [];
    });
    const posts = await Promise.all(Object.entries(groups).map(async ([id, objs]) => {
      // Skip metadata entries (ids beginning with underscore) so that
      // `posts/_meta.json` never appears as a post on the front page.
      if (id.startsWith('_')) return undefined;
      return await buildPost(id, objs, meta, false, false);
    }));
    const list = posts.filter(Boolean).sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json(list);
  } catch (err) {
    console.error('list posts error', err);
    res.status(500).json({ error: 'Could not list posts' });
  }
});

// List drafts.  Same as `/api/posts` but returns entries with `draft:true`.
app.get('/api/drafts', async (req, res) => {
  try {
    const meta = await readMeta();
    const objects = await listObjects('posts/');
    const filtered = objects.filter(o => !o.Key.startsWith('posts/.trash/'));
    const groups = {};
    filtered.forEach((obj) => {
      const base = path.basename(obj.Key).replace(/\.[^/.]+$/, '');
      groups[base] = groups[base] || [];
      groups[base].push(obj);
    });
    Object.keys(meta).forEach((mid) => {
      if (mid.startsWith('_')) return;
      if (!groups[mid]) groups[mid] = [];
    });
    const posts = await Promise.all(Object.entries(groups).map(async ([id, objs]) => {
      if (id.startsWith('_')) return undefined;
      return await buildPost(id, objs, meta, true, false);
    }));
    const drafts = posts.filter(p => p && p.draft).sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json(drafts);
  } catch (err) {
    console.error('list drafts error', err);
    res.status(500).json({ error: 'Could not list drafts' });
  }
});

// List trash.  Returns posts that have been soft‑deleted (moved to
// `posts/.trash/`).  Only admins can see the trash.
app.get('/api/trash', requireAdmin, async (req, res) => {
  try {
    const meta = await readMeta();
    const objects = await listObjects('posts/.trash/');
    // Group by id.
    const groups = {};
    objects.forEach((obj) => {
      const base = path.basename(obj.Key).replace(/\.[^/.]+$/, '');
      groups[base] = groups[base] || [];
      groups[base].push(obj);
    });
    const posts = await Promise.all(Object.entries(groups).map(async ([id, objs]) => {
      if (id.startsWith('_')) return undefined;
      return await buildPost(id, objs, meta, true, true);
    }));
    const trash = posts.filter(Boolean).sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json(trash);
  } catch (err) {
    console.error('list trash error', err);
    res.status(500).json({ error: 'Could not list trash' });
  }
});

// Upload audio file.  Accepts a single file field named `audio`.  A unique
// identifier is derived from the current timestamp.  The original file is
// persisted to R2 as `<id>.mp3` or `<id>.wav`.  A default meta entry is
// created.  Returns `{ id, filename }`.
app.post('/api/upload', requireAdmin, upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    // Determine extension and id.
    const ext = path.extname(req.file.originalname).toLowerCase().replace('.', '') || 'mp3';
    const id = Date.now().toString();
    const filename = `${id}.${ext}`;
    const key = `posts/${filename}`;
    // Write to R2.
    const buffer = fs.readFileSync(req.file.path);
    await putObject(key, buffer, req.file.mimetype || 'audio/mpeg');
    // Update metadata.
    const meta = await readMeta();
    meta[id] = meta[id] || { title: req.file.originalname.replace(/\.[^/.]+$/, ''), body: '', imageUrl: '', draft: false };
    await writeMeta(meta);
    // Remove local file.
    fs.unlinkSync(req.file.path);
    res.json({ id, filename });
  } catch (err) {
    console.error('upload error', err);
    res.status(500).json({ error: 'upload failed' });
  }
});

// Generate video from audio.  Accepts `{ filename, title }`.  Looks up the
// corresponding audio file in R2 (downloading it into a temporary file if
// needed) and runs ffmpeg with a safe spectrum filter.  On success the
// resulting MP4 is uploaded to R2 as `<id>.mp4`.  The temporary files are
// deleted.  Returns `{ ok:true, videoFilename }`.
app.post('/api/generate-video', requireAdmin, async (req, res) => {
  try {
    const { filename, title } = req.body || {};
    if (!filename) return res.status(400).json({ error: 'filename required' });
    const id = filename.replace(/\.[^/.]+$/, '');
    const audioKey = `posts/${filename}`;
    const localAudio = await downloadToTemp(audioKey);
    if (!localAudio) return res.status(404).json({ error: 'audio not found' });
    const outPath = path.join(TEMP_DIR, `${id}.mp4`);
    ffmpeg.setFfmpegPath(ffmpegStatic || undefined);
    await new Promise((resolve, reject) => {
      ffmpeg(localAudio)
        .outputOptions(['-y', '-threads', '1', '-preset', 'ultrafast', '-r', '24'])
        .complexFilter([
          // Reduce resolution to 640x360 to speed up generation.  The 16:9
          // aspect ratio is preserved.  Fall back to showwaves below with the
          // same resolution if this filter fails.
          '[0:a]aformat=channel_layouts=stereo,showspectrum=s=640x360:mode=combined:legend=disabled[v]'
        ])
        .outputOptions(['-map', '[v]', '-map', '0:a', '-shortest', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'])
        .videoCodec('libx264')
        .audioCodec('aac')
        .output(outPath)
        .on('end', resolve)
        .on('error', (err) => reject(err))
        .run();
    }).catch(async (err) => {
      // Fallback to showwaves filter if showspectrum is unavailable.
      return await new Promise((resolve, reject) => {
        ffmpeg(localAudio)
          .outputOptions(['-y', '-threads', '1', '-preset', 'ultrafast', '-r', '24'])
          .complexFilter([
            '[0:a]aformat=channel_layouts=stereo,showwaves=s=640x360:mode=line:rate=24,format=yuv420p[v]'
          ])
          .outputOptions(['-map', '[v]', '-map', '0:a', '-shortest', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'])
          .videoCodec('libx264')
          .audioCodec('aac')
          .output(outPath)
          .on('end', resolve)
          .on('error', (err2) => reject(err2))
          .run();
      });
    });
    // Upload to R2.
    const videoKey = `posts/${id}.mp4`;
    const videoBuffer = fs.readFileSync(outPath);
    await putObject(videoKey, videoBuffer, 'video/mp4');
    // Remove temp files.
    fs.unlinkSync(localAudio);
    fs.unlinkSync(outPath);
    // Optionally update title in metadata if provided.
    if (title) {
      const meta = await readMeta();
      meta[id] = meta[id] || {};
      meta[id].title = title;
      await writeMeta(meta);
    }
    res.json({ ok: true, id, videoFilename: `${id}.mp4` });
  } catch (err) {
    console.error('generate-video error', err);
    res.status(500).json({ error: 'generate-video failed' });
  }
});

// Create a new text/image post.  Accepts `{ title, body, imageUrl, published }`.
// A unique id is generated and an entry is created in meta.json.  If
// `published` is false then the post will appear in drafts.
app.post('/api/create-post', requireAdmin, async (req, res) => {
  try {
    const { title = '', body = '', imageUrl = '', published = true } = req.body || {};
    const id = Date.now().toString();
    const meta = await readMeta();
    meta[id] = { title, body, imageUrl, draft: !published };
    await writeMeta(meta);
    res.json({ ok: true, id });
  } catch (err) {
    console.error('create-post error', err);
    res.status(500).json({ error: 'create-post failed' });
  }
});

// Upload an image to R2.  Accepts a single file named `image`.  Images are
// stored under `images/<timestamp>-<random>.<ext>` and a public URL is
// returned.  The local temporary file is deleted afterwards.
app.post('/api/images/upload', requireAdmin, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const ext = path.extname(req.file.originalname).toLowerCase();
    const name = `${Date.now()}-${Math.floor(Math.random() * 1e6)}${ext}`;
    const key = `images/${name}`;
    const buffer = fs.readFileSync(req.file.path);
    await putObject(key, buffer, req.file.mimetype || 'image/png');
    fs.unlinkSync(req.file.path);
    res.json({ url: absoluteUrl(key) });
  } catch (err) {
    console.error('image upload error', err);
    res.status(500).json({ error: 'image upload failed' });
  }
});

// Update a post’s metadata.  Accepts any subset of { title, body, imageUrl, draft }.
app.patch('/api/posts/:id', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const fields = req.body || {};
    const meta = await readMeta();
    meta[id] = meta[id] || {};
    if (typeof fields.title === 'string') meta[id].title = fields.title;
    if (typeof fields.body === 'string') meta[id].body = fields.body;
    if (typeof fields.imageUrl === 'string') meta[id].imageUrl = fields.imageUrl;
    if (typeof fields.draft === 'boolean') meta[id].draft = fields.draft;
    await writeMeta(meta);
    res.json({ ok: true, id });
  } catch (err) {
    console.error('update meta error', err);
    res.status(500).json({ error: 'update failed' });
  }
});

// Soft delete a post.  Moves `<id>.mp3` and `<id>.mp4` from `posts/` into
// `posts/.trash/`.  The metadata entry remains intact.
app.delete('/api/posts/:id', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const exts = ['mp3', 'mp4'];
    const moved = [];
    for (const ext of exts) {
      const srcKey = `posts/${id}.${ext}`;
      const dstKey = `posts/.trash/${id}.${ext}`;
      // Attempt to copy then delete; if copy fails the file likely doesn’t exist.
      try {
        await copyObject(srcKey, dstKey);
        await deleteObject(srcKey);
        moved.push(`${id}.${ext}`);
      } catch {}
    }
    if (moved.length === 0) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, moved });
  } catch (err) {
    console.error('delete error', err);
    res.status(500).json({ error: 'delete failed' });
  }
});

// Restore a post from the trash.  Moves files back from `.trash/` to `posts/`.
app.post('/api/posts/:id/restore', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const exts = ['mp3', 'mp4'];
    const restored = [];
    for (const ext of exts) {
      const srcKey = `posts/.trash/${id}.${ext}`;
      const dstKey = `posts/${id}.${ext}`;
      try {
        await copyObject(srcKey, dstKey);
        await deleteObject(srcKey);
        restored.push(`${id}.${ext}`);
      } catch {}
    }
    if (restored.length === 0) return res.status(404).json({ error: 'not found in trash' });
    res.json({ ok: true, restored });
  } catch (err) {
    console.error('restore error', err);
    res.status(500).json({ error: 'restore failed' });
  }
});

// Permanently delete a post.  Removes files from `.trash/` and deletes the
// corresponding metadata entry.  Only admins can hard delete.
app.delete('/api/trash/:id', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const exts = ['mp3', 'mp4'];
    const removed = [];
    for (const ext of exts) {
      const key = `posts/.trash/${id}.${ext}`;
      try {
        await deleteObject(key);
        removed.push(`${id}.${ext}`);
      } catch {}
    }
    const meta = await readMeta();
    if (meta[id]) { delete meta[id]; await writeMeta(meta); }
    if (removed.length === 0) return res.status(404).json({ error: 'not found in trash' });
    res.json({ ok: true, removed });
  } catch (err) {
    console.error('hard delete error', err);
    res.status(500).json({ error: 'hard delete failed' });
  }
});

// Bulk soft delete: accepts `{ ids: [] }` and moves each id to the trash.
app.post('/api/posts/bulk-delete', requireAdmin, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ error: 'ids required' });
    const results = [];
    for (const id of ids) {
      const exts = ['mp3', 'mp4'];
      const moved = [];
      for (const ext of exts) {
        const srcKey = `posts/${id}.${ext}`;
        const dstKey = `posts/.trash/${id}.${ext}`;
        try {
          await copyObject(srcKey, dstKey);
          await deleteObject(srcKey);
          moved.push(`${id}.${ext}`);
        } catch {}
      }
      results.push({ id, moved });
    }
    res.json({ ok: true, results });
  } catch (err) {
    console.error('bulk delete error', err);
    res.status(500).json({ error: 'bulk delete failed' });
  }
});

// Bulk restore: accepts `{ ids: [] }` and restores each id from the trash.
app.post('/api/trash/bulk-restore', requireAdmin, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ error: 'ids required' });
    const results = [];
    for (const id of ids) {
      const exts = ['mp3', 'mp4'];
      const restored = [];
      for (const ext of exts) {
        const srcKey = `posts/.trash/${id}.${ext}`;
        const dstKey = `posts/${id}.${ext}`;
        try {
          await copyObject(srcKey, dstKey);
          await deleteObject(srcKey);
          restored.push(`${id}.${ext}`);
        } catch {}
      }
      results.push({ id, restored });
    }
    res.json({ ok: true, results });
  } catch (err) {
    console.error('bulk restore error', err);
    res.status(500).json({ error: 'bulk restore failed' });
  }
});

// Start the server.
app.listen(PORT, () => {
  console.log(`The Gargantuan backend v1.6.0 listening on port ${PORT}`);
});