const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

// Configure ffmpeg binary path.  Without this the ffmpeg module falls back
// to a globally installed binary which may not exist on Render.  By using
// ffmpeg-static we ensure a portable binary is available at runtime.
ffmpeg.setFfmpegPath(ffmpegPath);

// Pull environment variables.  Sensible defaults are provided so that
// development builds can run locally without Cloudflare R2 configured.  When
// deploying to Render the following variables must be supplied:
// ADMIN_TOKEN, S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY,
// S3_BUCKET, S3_PUBLIC_BASE and PORT.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'changeme';
const S3_ENDPOINT = process.env.S3_ENDPOINT || '';
const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID || '';
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY || '';
const S3_BUCKET = process.env.S3_BUCKET || '';
const S3_PUBLIC_BASE = process.env.S3_PUBLIC_BASE || '';
const PORT = process.env.PORT || 10000;

// Initialise an S3 client against the Cloudflare R2 endpoint.  AWS SDK v3 is
// modular so only the S3 client is imported.  When S3_ENDPOINT is not
// configured the client constructor gracefully handles an empty endpoint.  In
// that case helper functions below will operate against the local
// filesystem instead of R2.
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3');

let s3Client;
if (S3_ENDPOINT && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY) {
  s3Client = new S3Client({
    endpoint: S3_ENDPOINT,
    region: 'auto',
    credentials: {
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
  });
}

// Local fallback directory for object storage when S3 is not configured.  In
// development this allows the API to operate without R2.  The directory is
// created on demand.
const localStorageDir = path.join(__dirname, 'local-storage');

/**
 * Read a stream into a string.  The AWS SDK returns Node.js streams when
 * retrieving objects.  This helper collects all chunks and resolves with
 * the concatenated result.  If the stream emits an error the promise
 * rejects.
 * @param {Readable} stream
 * @returns {Promise<string>}
 */
function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

/**
 * Ensure that the given directory exists.  Synchronous to avoid race
 * conditions.  If the directory hierarchy does not exist it is created
 * recursively.
 * @param {string} dir
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Helper functions for interacting with Cloudflare R2.  When S3 is not
// configured the helpers fall back to reading and writing files in
// localStorageDir.
async function putFile(localPath, key, contentType) {
  if (s3Client) {
    const fileBuffer = fs.readFileSync(localPath);
    await s3Client.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: fileBuffer,
        ContentType: contentType || 'application/octet-stream',
      }),
    );
  } else {
    const dest = path.join(localStorageDir, key);
    ensureDir(path.dirname(dest));
    fs.copyFileSync(localPath, dest);
  }
}

async function putText(key, text) {
  const body = Buffer.from(text, 'utf-8');
  if (s3Client) {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: body,
        ContentType: 'application/json',
      }),
    );
  } else {
    const dest = path.join(localStorageDir, key);
    ensureDir(path.dirname(dest));
    fs.writeFileSync(dest, body);
  }
}

async function getText(key) {
  if (s3Client) {
    try {
      const obj = await s3Client.send(
        new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }),
      );
      const text = await streamToString(obj.Body);
      return text;
    } catch (err) {
      if (err.$metadata && err.$metadata.httpStatusCode === 404) {
        return null;
      }
      throw err;
    }
  } else {
    const filePath = path.join(localStorageDir, key);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf-8');
  }
}

async function list(prefix) {
  if (s3Client) {
    const items = [];
    let continuationToken;
    do {
      const params = {
        Bucket: S3_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      };
      const resp = await s3Client.send(new ListObjectsV2Command(params));
      const contents = resp.Contents || [];
      contents.forEach((c) => items.push(c));
      continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (continuationToken);
    return items;
  } else {
    // Local listing
    const dir = path.join(localStorageDir, prefix);
    if (!fs.existsSync(dir)) return [];
    const files = [];
    function walk(current) {
      const entries = fs.readdirSync(current);
      entries.forEach((entry) => {
        const fullPath = path.join(current, entry);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath);
        } else {
          const rel = path.relative(localStorageDir, fullPath).replace(/\\/g, '/');
          files.push({ Key: rel, LastModified: stat.mtime, Size: stat.size });
        }
      });
    }
    walk(dir);
    return files;
  }
}

async function copy(srcKey, dstKey) {
  if (s3Client) {
    await s3Client.send(
      new CopyObjectCommand({
        Bucket: S3_BUCKET,
        CopySource: `${S3_BUCKET}/${srcKey}`,
        Key: dstKey,
      }),
    );
  } else {
    const srcPath = path.join(localStorageDir, srcKey);
    const dstPath = path.join(localStorageDir, dstKey);
    ensureDir(path.dirname(dstPath));
    fs.copyFileSync(srcPath, dstPath);
  }
}

async function remove(key) {
  if (s3Client) {
    await s3Client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  } else {
    const filePath = path.join(localStorageDir, key);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
}

async function downloadToTemp(key, localPath) {
  if (s3Client) {
    const obj = await s3Client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    const writeStream = fs.createWriteStream(localPath);
    await new Promise((resolve, reject) => {
      obj.Body.pipe(writeStream);
      obj.Body.on('error', reject);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });
  } else {
    const src = path.join(localStorageDir, key);
    fs.copyFileSync(src, localPath);
  }
}

// Metadata handling
const META_KEY = 'posts/_meta.json';

/**
 * Load the post metadata JSON from R2 or local storage.  Returns an object
 * keyed by post id.  Missing files yield an empty object.
 * @returns {Promise<object>}
 */
async function loadMeta() {
  const text = await getText(META_KEY);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    console.error('Failed to parse metadata', err);
    return {};
  }
}

/**
 * Persist the provided metadata to R2 or local storage.  The JSON is
 * stringified with two‑space indentation for readability.  The returned
 * promise resolves once the upload or write has completed.
 * @param {object} meta
 * @returns {Promise<void>}
 */
async function saveMeta(meta) {
  const text = JSON.stringify(meta, null, 2);
  await putText(META_KEY, text);
}

// Ensure the uploads directory exists.  Multer will place incoming
// multipart/form‑data files here.  After processing we remove the files to
// avoid filling the disk.
const uploadsDir = path.join(__dirname, 'uploads');
ensureDir(uploadsDir);
const upload = multer({ dest: uploadsDir });

// In‑memory job registry.  When a video generation job is created the
// progress and status are stored here keyed by jobId.  When the process
// restarts the registry resets; this is acceptable because long‑running
// jobs are unlikely in the context of a small Render dyno.
const jobs = {};

// Create the Express application and apply global middleware.
const app = express();
app.use(cors());
app.use(express.json());

// Health and version endpoints
app.get('/', (req, res) => {
  res.send('The Gargantuan backend is live.');
});

app.get('/api/version', (req, res) => {
  res.json({ version: '1.6.0' });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/r2/health', async (req, res) => {
  if (!s3Client) {
    return res.json({ ok: true, enabled: false, count: 0 });
  }
  try {
    const files = await list('posts/');
    res.json({ ok: true, enabled: true, count: files.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, enabled: true, error: err.message });
  }
});

/**
 * Middleware to enforce the admin token on protected routes.  The client
 * must send a header `x-admin-token` matching ADMIN_TOKEN.  When the token
 * does not match a 401 response is returned.
 */
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

/**
 * Assemble a list of posts or drafts by reading objects under the given
 * prefix.  Each item in R2 yields a base filename (without extension).  The
 * metadata is looked up for each id.  The response shape conforms to the
 * specification: { id, title, body, imageUrl, draft, type, playUrl, audioUrl,
 * videoUrl, date }.  Items are sorted by last modified date descending.
 * @param {boolean} includeDrafts
 * @param {boolean} trash
 * @returns {Promise<object[]>}
 */
async function assemblePosts(includeDrafts, trash = false) {
  const prefix = trash ? 'posts/.trash/' : 'posts/';
  const objects = await list(prefix);
  const meta = await loadMeta();
  // Group by id
  const groups = {};
  objects.forEach((obj) => {
    const key = obj.Key;
    const filename = key.split('/').pop();
    // Skip metadata file and directories
    if (!filename) return;
    if (filename === '_meta.json') return;
    const idWithExt = filename;
    const baseId = idWithExt.substring(0, idWithExt.lastIndexOf('.'));
    const ext = idWithExt.substring(idWithExt.lastIndexOf('.') + 1).toLowerCase();
    if (!groups[baseId]) {
      groups[baseId] = { id: baseId, files: {}, lastModified: obj.LastModified };
    }
    if (ext === 'mp3' || ext === 'wav') {
      groups[baseId].files.audio = key;
    }
    if (ext === 'mp4') {
      groups[baseId].files.video = key;
    }
    // Track most recent modification time
    if (obj.LastModified && obj.LastModified > groups[baseId].lastModified) {
      groups[baseId].lastModified = obj.LastModified;
    }
  });
  // Construct items
  const items = [];
  Object.values(groups).forEach((entry) => {
    const m = meta[entry.id] || {};
    const draft = !!m.draft;
    if (!includeDrafts && draft) return;
    if (includeDrafts && !draft) return;
    const audioUrl = entry.files.audio
      ? `${S3_PUBLIC_BASE}/${entry.files.audio}`
      : '';
    const videoUrl = entry.files.video
      ? `${S3_PUBLIC_BASE}/${entry.files.video}`
      : '';
    let type = 'text';
    let playUrl = '';
    if (entry.files.video) {
      type = 'video';
      playUrl = videoUrl;
    } else if (entry.files.audio) {
      type = 'audio';
      playUrl = audioUrl;
    } else if (m.imageUrl) {
      type = 'image';
    }
    items.push({
      id: entry.id,
      title: m.title || '',
      body: m.body || '',
      imageUrl: m.imageUrl || '',
      draft,
      type,
      playUrl,
      audioUrl,
      videoUrl,
      date: entry.lastModified,
    });
  });
  // Sort descending by date
  items.sort((a, b) => new Date(b.date) - new Date(a.date));
  return items;
}

// GET /api/posts – list published posts
app.get('/api/posts', async (req, res) => {
  try {
    const items = await assemblePosts(false);
    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/drafts – list drafts
app.get('/api/drafts', async (req, res) => {
  try {
    const items = await assemblePosts(true);
    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/trash – list trashed items (optional)
app.get('/api/trash', async (req, res) => {
  try {
    const items = await assemblePosts(true, true);
    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/upload – accept an audio file and upload it to R2.  The
// response contains the filename (id with extension) which is later used
// when generating a video.  The endpoint also initialises a metadata entry.
app.post('/api/upload', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No file provided' });
    }
    const ext = path.extname(file.originalname).replace('.', '').toLowerCase();
    if (!['mp3', 'wav'].includes(ext)) {
      return res.status(400).json({ error: 'Unsupported file type' });
    }
    // Generate an id based off timestamp and a random uuid suffix to avoid
    // collisions.  Preserve the extension for clarity.  When converting
    // during video generation we will normalise to mp3.
    const id = Date.now().toString() + '-' + uuidv4();
    const filename = `${id}.${ext}`;
    const key = `posts/${filename}`;
    // Upload the file to R2 or local storage
    await putFile(file.path, key, ext === 'mp3' ? 'audio/mpeg' : 'audio/wav');
    // Initialise meta entry
    const meta = await loadMeta();
    meta[id] = meta[id] || {
      title: file.originalname.replace(/\.[^/.]+$/, ''),
      body: '',
      imageUrl: '',
      draft: false,
    };
    await saveMeta(meta);
    // Delete uploaded temp file
    fs.unlinkSync(file.path);
    res.json({ filename });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/generate-video – generate a spectrum video from an audio file.  The
// request body should include { filename, title }.  A new job is created
// and the client polls /api/jobs/:id for progress updates.  On success the
// video is uploaded to R2 and the job result contains the video filename.
app.post('/api/generate-video', requireAdmin, async (req, res) => {
  const { filename, title } = req.body || {};
  if (!filename) {
    return res.status(400).json({ error: 'Missing filename' });
  }
  // Extract id and extension
  const baseId = filename.substring(0, filename.lastIndexOf('.'));
  const ext = filename.substring(filename.lastIndexOf('.') + 1).toLowerCase();
  const jobId = uuidv4();
  jobs[jobId] = { status: 'running', progress: 0 };
  res.status(202).json({ jobId });
  // Background task
  (async () => {
    try {
      // Ensure the audio file exists in uploads.  If not present locally
      // download from R2 to a temporary path.
      const localAudio = path.join(uploadsDir, `${baseId}.${ext}`);
      if (!fs.existsSync(localAudio)) {
        await downloadToTemp(`posts/${filename}`, localAudio);
      }
      // Always convert to mp3 for ffmpeg input; if the audio is already mp3
      // this step simply copies the file.  The conversion step uses ffmpeg
      // because Cloudflare may not accept wav files in the video container.
      const inputForVideo = path.join(uploadsDir, `${baseId}.mp3`);
      if (ext === 'mp3') {
        fs.copyFileSync(localAudio, inputForVideo);
      } else {
        await new Promise((resolve, reject) => {
          ffmpeg(localAudio)
            .outputOptions('-y')
            .audioCodec('libmp3lame')
            .save(inputForVideo)
            .on('end', resolve)
            .on('error', reject);
        });
      }
      // Define temp output video path
      const tempVideo = path.join(uploadsDir, `${baseId}.mp4`);
      // Attempt first filter (showspectrum).  On failure fallback to showwaves.
      const runFfmpegWithFilter = (filter) => {
        return new Promise((resolve, reject) => {
          ffmpeg(inputForVideo)
            .inputOptions('-vn')
            .audioFilters(filter)
            .complexFilter(['[0:a]aformat=channel_layouts=stereo', `${filter}[v]`])
            .outputOptions([
              '-y',
              '-preset',
              'ultrafast',
              '-r',
              '24',
              '-pix_fmt',
              'yuv420p',
              '-movflags',
              '+faststart',
              '-map',
              '[v]',
              '-map',
              '0:a',
              '-shortest',
            ])
            .on('progress', (p) => {
              // Progress is between 0 and 100; clamp to 99 to leave room for
              // upload and finalisation.  p.percent is not always provided so
              // compute based on time.
              const percent = p.percent || 0;
              jobs[jobId].progress = Math.min(99, Math.round(percent));
            })
            .on('error', reject)
            .on('end', resolve)
            .save(tempVideo);
        });
      };
      const spectrumFilter = 'showspectrum=s=854x480:mode=combined:legend=disabled';
      try {
        await runFfmpegWithFilter(spectrumFilter);
      } catch (err) {
        console.warn('Spectrum filter failed, falling back to wave filter', err.message);
        const waveFilter = 'showwaves=s=854x480:mode=line:rate=24,format=yuv420p';
        await runFfmpegWithFilter(waveFilter);
      }
      // Upload generated video to R2
      const videoKey = `posts/${baseId}.mp4`;
      await putFile(tempVideo, videoKey, 'video/mp4');
      // Clean up temporary files
      fs.unlinkSync(tempVideo);
      fs.unlinkSync(localAudio);
      fs.unlinkSync(inputForVideo);
      // Update meta title if provided
      if (title) {
        const meta = await loadMeta();
        if (!meta[baseId]) meta[baseId] = { title: '', body: '', imageUrl: '', draft: false };
        meta[baseId].title = title;
        await saveMeta(meta);
      }
      jobs[jobId] = { status: 'done', progress: 100, result: { video: `${baseId}.mp4` } };
    } catch (err) {
      console.error('Generate video failed', err);
      jobs[jobId] = { status: 'error', progress: 100, error: err.message };
    }
  })();
});

// GET /api/jobs/:id – return job status and progress
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json(job);
});

// PATCH /api/posts/:id – update metadata for a post
app.patch('/api/posts/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { title, body, imageUrl, draft } = req.body || {};
  try {
    const meta = await loadMeta();
    meta[id] = meta[id] || { title: '', body: '', imageUrl: '', draft: false };
    if (title !== undefined) meta[id].title = title;
    if (body !== undefined) meta[id].body = body;
    if (imageUrl !== undefined) meta[id].imageUrl = imageUrl;
    if (draft !== undefined) meta[id].draft = !!draft;
    await saveMeta(meta);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/create-post – create a new text/image post
app.post('/api/create-post', requireAdmin, async (req, res) => {
  const { title, body, imageUrl, published } = req.body || {};
  if (!title) return res.status(400).json({ error: 'Missing title' });
  try {
    const id = Date.now().toString() + '-' + uuidv4();
    const meta = await loadMeta();
    meta[id] = {
      title: title || '',
      body: body || '',
      imageUrl: imageUrl || '',
      draft: published === true ? false : true,
    };
    await saveMeta(meta);
    res.json({ ok: true, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/images/upload – accept an image and return its URL.  The image
// is stored under images/ with a timestamp and random suffix.  Valid image
// formats are not restricted at this layer; any file will be uploaded.
app.post('/api/images/upload', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file provided' });
    const timestamp = Date.now();
    const rand = uuidv4();
    const ext = path.extname(file.originalname) || '';
    const key = `images/${timestamp}-${rand}${ext}`;
    const contentType = file.mimetype || 'application/octet-stream';
    await putFile(file.path, key, contentType);
    fs.unlinkSync(file.path);
    const url = `${S3_PUBLIC_BASE}/${key}`;
    res.json({ url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/posts/:id – move post files into trash and optionally remove meta
app.delete('/api/posts/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    // Move audio and video to trash if they exist
    const audioKey = `posts/${id}.mp3`;
    const videoKey = `posts/${id}.mp4`;
    const trashAudioKey = `posts/.trash/${id}.mp3`;
    const trashVideoKey = `posts/.trash/${id}.mp4`;
    // Attempt copies – ignore errors if the source does not exist
    try { await copy(audioKey, trashAudioKey); await remove(audioKey); } catch (_) {}
    try { await copy(videoKey, trashVideoKey); await remove(videoKey); } catch (_) {}
    // Mark meta entry as draft to hide from published list
    const meta = await loadMeta();
    if (meta[id]) {
      meta[id].draft = true;
      await saveMeta(meta);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/posts/:id/restore – restore files from trash
app.post('/api/posts/:id/restore', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const audioKey = `posts/${id}.mp3`;
    const videoKey = `posts/${id}.mp4`;
    const trashAudioKey = `posts/.trash/${id}.mp3`;
    const trashVideoKey = `posts/.trash/${id}.mp4`;
    try { await copy(trashAudioKey, audioKey); await remove(trashAudioKey); } catch (_) {}
    try { await copy(trashVideoKey, videoKey); await remove(trashVideoKey); } catch (_) {}
    // Unmark draft
    const meta = await loadMeta();
    if (meta[id]) {
      meta[id].draft = false;
      await saveMeta(meta);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/trash/:id – permanently delete files from trash and remove
// metadata entry.  If no files exist the request still succeeds.
app.delete('/api/trash/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const trashAudioKey = `posts/.trash/${id}.mp3`;
    const trashVideoKey = `posts/.trash/${id}.mp4`;
    try { await remove(trashAudioKey); } catch (_) {}
    try { await remove(trashVideoKey); } catch (_) {}
    const meta = await loadMeta();
    delete meta[id];
    await saveMeta(meta);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Start the server.  When PORT is set the listener binds to that port.
app.listen(PORT, () => {
  console.log(`The Gargantuan backend listening on port ${PORT}`);
});