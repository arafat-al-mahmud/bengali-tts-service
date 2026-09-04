import bcrypt from 'bcryptjs';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { hashApiKey, hashesMatch, looksLikeApiKey } from '../lib/api-keys.js';
import {
  InvalidApiKey,
  InvalidCredentials,
  MissingApiKey,
  MissingCredentials,
  RevokedApiKey,
  Unauthenticated,
} from '../lib/errors.js';
import type { PrismaClient } from '../lib/prisma.js';

export interface AuthedUser {
  id: string;
  email: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser;
    }
  }
}

export function requireUser(req: Request): AuthedUser {
  if (!req.user) throw new Unauthenticated();
  return req.user;
}

/**
 * HTTP Basic auth with the user email and password. Guards API key
 * management only; everything else authenticates with an API key.
 */
export function basicAuth(prisma: PrismaClient): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Basic ')) {
      throw new MissingCredentials();
    }
    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    const email = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);

    const user = await prisma.user.findUnique({ where: { email } });
    // Always burn a bcrypt comparison so an unknown email costs the same
    // as a wrong password.
    const hash = user?.passwordHash ?? (await bcrypt.hash('decoy-password', 4));
    const valid = await bcrypt.compare(password, hash);
    if (!user || !valid) {
      throw new InvalidCredentials();
    }
    req.user = { id: user.id, email: user.email };
    next();
  };
}

/**
 * Bearer auth with an API key. The key is looked up by its SHA-256 hash;
 * the stored hash is re-compared in constant time as defense in depth.
 */
export function apiKeyAuth(prisma: PrismaClient): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new MissingApiKey();
    }
    const key = header.slice('Bearer '.length).trim();
    if (!looksLikeApiKey(key)) {
      throw new InvalidApiKey();
    }
    const keyHash = hashApiKey(key);
    const record = await prisma.apiKey.findUnique({
      where: { keyHash },
      include: { user: true },
    });
    if (!record || !hashesMatch(record.keyHash, keyHash)) {
      throw new InvalidApiKey();
    }
    if (record.revokedAt) {
      throw new RevokedApiKey();
    }
    // Best-effort freshness marker; auth must not fail on a write hiccup.
    prisma.apiKey
      .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
    req.user = { id: record.user.id, email: record.user.email };
    next();
  };
}
