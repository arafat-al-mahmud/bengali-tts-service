import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { generateApiKey } from '../lib/api-keys.js';
import { ApiError } from '../lib/errors.js';
import { basicAuth, requireUser } from '../middleware/auth.js';

export function keysRouter(deps: AppDeps): Router {
  const router = Router();
  router.use('/v1/keys', basicAuth(deps.prisma));

  router.post('/v1/keys', async (req, res) => {
    const user = requireUser(req);
    const { key, keyHash, keyPrefix } = generateApiKey();
    const record = await deps.prisma.apiKey.create({
      data: { userId: user.id, keyHash, keyPrefix },
    });
    // The only response that ever contains the full key.
    res.status(201).json({ id: record.id, key, keyPrefix, createdAt: record.createdAt });
  });

  router.get('/v1/keys', async (req, res) => {
    const user = requireUser(req);
    const records = await deps.prisma.apiKey.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json({
      keys: records.map((k) => ({
        id: k.id,
        keyPrefix: k.keyPrefix,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
        revokedAt: k.revokedAt,
      })),
    });
  });

  router.delete('/v1/keys/:id', async (req, res) => {
    const user = requireUser(req);
    // updateMany scoped to the owner: someone else's key id affects zero
    // rows and is indistinguishable from a nonexistent one.
    const result = await deps.prisma.apiKey.updateMany({
      where: { id: req.params.id, userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) {
      throw new ApiError(404, 'NOT_FOUND', 'Resource not found');
    }
    res.status(204).end();
  });

  return router;
}
