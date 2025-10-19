import express from "express";
const router = express.Router();

export default function postsRoute(postsRef) {
  router.get("/", (_, res) => res.json(postsRef.value));
  router.post("/", (req, res) => {
    const newPost = { ...req.body, createdAt: Date.now(), id: Date.now().toString() };
    postsRef.value.unshift(newPost);
    res.json(newPost);
  });
  router.delete("/:id", (req, res) => {
    postsRef.value = postsRef.value.filter(p => p.id !== req.params.id);
    res.json({ success: true });
  });
  return router;
}
