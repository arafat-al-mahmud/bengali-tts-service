import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { apiKeyAuth, requireUser } from '../middleware/auth.js';

/**
 * Minimal authenticated probe: lets a client verify an API key works
 * before submitting jobs, and gives tests a stable auth target.
 */
export function meRouter(deps: AppDeps): Router {
  const router = Router();

  router.get('/v1/me', apiKeyAuth(deps.prisma), (req, res) => {
    const user = requireUser(req);
    res.json({ id: user.id, email: user.email });
  });

  return router;
}
