import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { buildNotifications, markRead } from "../services/notifications.js";

const router = Router();
router.use(requireAuth);

/** GET /api/notifications — what needs this person's attention right now. */
router.get("/", async (req, res) => {
  res.json(await buildNotifications(req.user));
});

/** POST /api/notifications/read — { keys: [...] } marks those as read;
 *  { all: true } marks everything currently shown. */
router.post("/read", async (req, res) => {
  let keys = req.body?.keys;
  if (req.body?.all === true) {
    keys = (await buildNotifications(req.user)).notifications.map((n) => n.key);
  } else if (!Array.isArray(keys)) {
    return res.status(400).json({ error: "keys (array) or all: true is required" });
  }
  res.json({ marked: await markRead(req.user.id, keys) });
});

export default router;
