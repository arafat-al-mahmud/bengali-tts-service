import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { ApiError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';

const BCRYPT_ROUNDS = 12;

const registerSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(8).max(128),
});

export function authRouter(deps: AppDeps): Router {
  const router = Router();

  router.post('/v1/auth/register', async (req, res) => {
    const { email, password } = validate(registerSchema, req.body);
    const existing = await deps.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ApiError(409, 'EMAIL_TAKEN', 'A user with this email already exists');
    }
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = await deps.prisma.user.create({ data: { email, passwordHash } });
    res.status(201).json({ id: user.id, email: user.email, createdAt: user.createdAt });
  });

  return router;
}
