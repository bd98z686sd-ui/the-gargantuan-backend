# The Gargantuan — Backend (Soft Delete + Bulk)
- Soft delete moves items to `uploads/.trash`
- Restore single or bulk from trash
- Hard delete from trash
- Bulk delete from posts

## Endpoints (all protected by ADMIN_TOKEN except GET lists)
GET  /api/posts
GET  /api/trash
POST /api/upload
POST /api/generate-video
PATCH /api/posts/:id
DELETE /api/posts/:id                (soft delete)
POST /api/posts/:id/restore          (restore one)
DELETE /api/trash/:id                (hard delete one)
POST /api/posts/bulk-delete          { ids: [baseName|filename, ...] }
POST /api/trash/bulk-restore         { ids: [baseName|filename, ...] }
