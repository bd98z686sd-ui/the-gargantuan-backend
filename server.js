// server.js (ESM, Node 20)
// Env: ADMIN_TOKEN, S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET, S3_PUBLIC_BASE, PORT
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import * as fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { S3Client, PutObjectCommand, GetObjectCommand, CopyObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

const app = express();
app.use(cors());
app.use(express.json());

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({ dest: UPLOAD_DIR });

function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_TOKEN || '';
  const provided = req.get('x-admin-token') || '';
  if (!expected || provided !== expected) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// R2 client
const S3_ENABLED = !!process.env.S3_ENDPOINT;
const s3 = S3_ENABLED ? new S3Client({
  region: 'auto',
  endpoint: process.env.S3_ENDPOINT,
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY },
  forcePathStyle: true,
}) : null;

const S3_BUCKET = process.env.S3_BUCKET;
const S3_PUBLIC_BASE = (process.env.S3_PUBLIC_BASE || '').replace(/\/+$/, '');
const META_KEY = 'posts/_meta.json';
const keyPosts = (filename) => `posts/${filename}`;
const keyTrash = (filename) => `posts/.trash/${filename}`;

// R2 helpers
async function r2PutFile(localPath, key, contentType) {
  if (!S3_ENABLED) throw new Error('R2 disabled');
  await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: fs.createReadStream(localPath), ContentType: contentType || 'application/octet-stream' }));
  return S3_PUBLIC_BASE ? `${S3_PUBLIC_BASE}/${key}` : null;
}
async function r2PutText(key, text) {
  await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: text, ContentType: 'application/json' }));
}
async function r2GetText(key) {
  const obj = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  return await obj.Body.transformToString();
}
async function r2Copy(srcKey, dstKey) { await s3.send(new CopyObjectCommand({ Bucket: S3_BUCKET, CopySource: `${S3_BUCKET}/${srcKey}`, Key: dstKey })); }
async function r2Delete(key) { await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key })); }
async function r2List(prefix='posts/') {
  const out = await s3.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: prefix }));
  return (out.Contents || []).map(o => ({ Key:o.Key, LastModified:o.LastModified }));
}
async function r2DownloadToTemp(key, localPath){
  const obj = await s3.send(new GetObjectCommand({ Bucket:S3_BUCKET, Key:key }));
  await new Promise((resolve, reject)=>{
    const ws = fs.createWriteStream(localPath);
    obj.Body.pipe(ws);
    obj.Body.on('error', reject);
    ws.on('finish', resolve);
    ws.on('error', reject);
  });
}

// Meta
async function readMeta(){ try { return JSON.parse(await r2GetText(META_KEY)); } catch { return {}; } }
async function writeMeta(meta){ await r2PutText(META_KEY, JSON.stringify(meta, null, 2)); }

// Jobs
const jobs = new Map();
app.get('/api/jobs/:id', (req,res)=>{
  const j = jobs.get(req.params.id);
  if(!j) return res.status(404).json({ error:'not found' });
  res.json(j);
});

// Health
app.get('/', (_req,res)=>res.send('The Gargantuan backend is live.'));
app.get('/api/version', (_req,res)=>res.json({ version:'1.3.7' }));
app.get('/api/health', (_req,res)=>res.json({ ok:true }));
app.get('/api/r2/health', async (_req,res)=>{
  try{ const list = await r2List('posts/'); res.json({ ok:true, enabled:!!S3_ENABLED, count:list.length }); }
  catch(e){ res.status(500).json({ ok:false, error:String(e) }); }
});

// List posts/trash with playUrl + metadata
async function listItems(isTrash){
  const prefix = isTrash ? 'posts/.trash/' : 'posts/';
  const objs = await r2List(prefix);
  const meta = await readMeta();
  const byBase = new Map();
  for(const o of objs){
    const key = o.Key;
    const fname = key.split('/').pop();
    if(!fname) continue;
    const ext = fname.split('.').pop().toLowerCase();
    if(!['mp3','mp4'].includes(ext)) continue;
    const base = fname.replace(/\.[^/.]+$/, '');
    const rec = byBase.get(base) || { id:base, audioUrl:null, videoUrl:null, date: new Date().toISOString() };
    if(ext==='mp3') rec.audioUrl = `${S3_PUBLIC_BASE}/${key}`;
    if(ext==='mp4') rec.videoUrl = `${S3_PUBLIC_BASE}/${key}`;
    rec.date = o.LastModified ? new Date(o.LastModified).toISOString() : rec.date;
    byBase.set(base, rec);
  }
  const items = [];
  for(const [base, rec] of byBase.entries()){
    const title = meta[base]?.title || base;
    const body  = meta[base]?.body || '';
    const hasVideo = !!rec.videoUrl;
    const playUrl = hasVideo ? rec.videoUrl : rec.audioUrl;
    items.push({ id:base, filename: hasVideo?`${base}.mp4`:`${base}.mp3`, title, body, type: hasVideo?'video':'audio', url: playUrl, playUrl, audioUrl: rec.audioUrl||'', videoUrl: rec.videoUrl||'', date: rec.date });
  }
  items.sort((a,b)=> new Date(b.date)-new Date(a.date));
  return items;
}
app.get('/api/posts', async (_req,res)=>{ try{ res.json(await listItems(false)); } catch{ res.status(500).json({ error:'list failed' }); } });
app.get('/api/trash', async (_req,res)=>{ try{ res.json(await listItems(true)); } catch{ res.status(500).json({ error:'list failed' }); } });

// Upload audio
app.post('/api/upload', requireAdmin, upload.single('audio'), async (req,res)=>{
  try{
    if(!req.file) return res.status(400).json({ error:'missing audio' });
    const localPath = req.file.path;
    const baseId = req.file.filename.replace(/\.[^/.]+$/, '');
    const r2Name = `${baseId}.mp3`;
    const r2Url = await r2PutFile(localPath, keyPosts(r2Name), 'audio/mpeg');
    const meta = await readMeta(); meta[baseId] = meta[baseId] || {}; meta[baseId].title = req.file.originalname || baseId; await writeMeta(meta);
    res.json({ filename: r2Name, title: meta[baseId].title, r2Url });
  } catch(e){ console.error('upload error', e); res.status(500).json({ error:'upload failed' }); }
});

// Generate video with safe spectrum + fallback waveform
app.post('/api/generate-video', requireAdmin, async (req,res)=>{
  try{
    const { filename, title='The Gargantuan' } = req.body || {};
    if(!filename) return res.status(400).json({ error:'filename required' });
    const base = filename.replace(/\.[^/.]+$/, '');
    const inPath = path.join(UPLOAD_DIR, filename);
    const r2AudioKey = keyPosts(filename);
    if(!fs.existsSync(inPath)) await r2DownloadToTemp(r2AudioKey, inPath);
    const outName = `${base}.mp4`; const outPath = path.join(UPLOAD_DIR, outName);

    const jobId = crypto.randomUUID(); jobs.set(jobId, { status:'running', progress:1 }); res.status(202).json({ jobId });

    ffmpeg.setFfmpegPath(ffmpegStatic || undefined);
    async function runFfmpegWith(filterGraph){
      return await new Promise((resolve,reject)=>{
        let last=0;
        ffmpeg(inPath)
          .videoCodec('libx264').audioCodec('aac')
          .outputOptions(['-y','-preset','ultrafast','-r','24','-pix_fmt','yuv420p','-movflags','+faststart','-map','[v]','-map','0:a','-shortest'])
          .complexFilter([ filterGraph ])
          .on('progress', (p)=>{
            if(typeof p.percent==='number'){ last=Math.max(last, Math.min(99, Math.round(p.percent))); const j=jobs.get(jobId)||{}; jobs.set(jobId, { ...j, progress:last }); }
          })
          .on('end', ()=> resolve())
          .on('error', (err)=> reject(err))
          .save(outPath);
      });
    }
    const FILTER_SAFE_SPECTRUM = "[0:a]aformat=channel_layouts=stereo,showspectrum=s=854x480:mode=combined:legend=disabled[v]";
    const FILTER_FALLBACK_WAVES = "[0:a]aformat=channel_layouts=stereo,showwaves=s=854x480:mode=line:rate=24,format=yuv420p[v]";

    try { await runFfmpegWith(FILTER_SAFE_SPECTRUM); }
    catch(e1){ console.error('spectrum failed, fallback to showwaves:', e1?.message||e1); await runFfmpegWith(FILTER_FALLBACK_WAVES); }

    try{
      const r2Url = await r2PutFile(outPath, keyPosts(outName), 'video/mp4');
      try{ fs.unlinkSync(inPath); }catch{}
      try{ fs.unlinkSync(outPath); }catch{}
      const meta = await readMeta(); meta[base] = meta[base] || {}; meta[base].title = title; await writeMeta(meta);
      const j = jobs.get(jobId) || {}; jobs.set(jobId, { ...j, status:'done', progress:100, result:{ output: outName, r2Url } });
    }catch(err){ const j=jobs.get(jobId)||{}; jobs.set(jobId, { ...j, status:'error', error:'upload failed' }); }
  }catch(err){ console.error('generate error', err); res.status(500).json({ error:'server error' }); }
});

// Edit title/body
app.patch('/api/posts/:id', requireAdmin, async (req,res)=>{
  try{
    const id = req.params.id; const base = id.replace(/\.[^/.]+$/, '');
    const payload = req.body || {}; const meta = await readMeta(); meta[base] = meta[base] || {};
    if(payload.title!==undefined) meta[base].title = payload.title;
    if(payload.body!==undefined) meta[base].body = payload.body;
    await writeMeta(meta);
    res.json({ ok:true, id:base, title: meta[base].title, body: meta[base].body || '' });
  }catch{ res.status(500).json({ error:'update failed' }); }
});

// Delete/restore/hard delete
app.delete('/api/posts/:id', requireAdmin, async (req,res)=>{
  try{
    const id = req.params.id; const base = id.replace(/\.[^/.]+$/, '');
    const files = [`${base}.mp3`, `${base}.mp4`]; const moved=[];
    for(const f of files){ try{ await r2Copy(keyPosts(f), keyTrash(f)); await r2Delete(keyPosts(f)); moved.push(f); }catch{} }
    res.json({ ok:true, moved });
  }catch{ res.status(500).json({ error:'soft delete failed' }); }
});
app.post('/api/posts/:id/restore', requireAdmin, async (req,res)=>{
  try{
    const id = req.params.id; const base = id.replace(/\.[^/.]+$/, '');
    const files = [`${base}.mp3`, `${base}.mp4`]; const restored=[];
    for(const f of files){ try{ await r2Copy(keyTrash(f), keyPosts(f)); await r2Delete(keyTrash(f)); restored.push(f); }catch{} }
    res.json({ ok:true, restored });
  }catch{ res.status(500).json({ error:'restore failed' }); }
});
app.delete('/api/trash/:id', requireAdmin, async (req,res)=>{
  try{
    const id = req.params.id; const base = id.replace(/\.[^/.]+$/, '');
    const files = [`${base}.mp3`, `${base}.mp4`]; const deleted=[];
    for(const f of files){ try{ await r2Delete(keyTrash(f)); deleted.push(f); }catch{} }
    res.json({ ok:true, deleted });
  }catch{ res.status(500).json({ error:'hard delete failed' }); }
});

// Image upload
app.post('/api/images/upload', requireAdmin, upload.single('image'), async (req,res)=>{
  try{
    if(!req.file) return res.status(400).json({ error:'missing image' });
    const ext = String(req.file.originalname.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g,'') || 'png';
    const key = `images/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
    const url = await r2PutFile(req.file.path, key, req.file.mimetype || 'application/octet-stream');
    try{ fs.unlinkSync(req.file.path); }catch{}
    res.json({ ok:true, url, key });
  }catch(e){ console.error('image upload error', e); res.status(500).json({ error:'image upload failed' }); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=> console.log('Backend listening on', PORT));
