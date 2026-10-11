// path: src/app.ts

import express, { type Application, type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { sql } from 'drizzle-orm';
import { db } from './config/database.js';
import { ApiResponse } from './utils/api-response.util.js';
import { ApiError } from './utils/api.error.js';
import { globalErrorHandler } from './middlewares/error.middleware.js';
import v1Router from './routes/v1.routes.js';
import { env } from './config/env.js';
import { sanitizeInput } from './middlewares/sanitizer.middleware.js';
import { ipGuard } from './middlewares/ip-guard.middleware.js';

const app: Application = express();

// =========================================================================
// 1. ENTERPRISE SECURITY & BASIC MIDDLEWARES
// =========================================================================
app.use(helmet());
app.set('trust proxy', 1);

const isWildcardAllowed = env.CORS_ORIGIN.includes('*');

const corsOptions: cors.CorsOptions = {
  origin: (requestOrigin, callback) => {
    if (!requestOrigin || isWildcardAllowed || env.CORS_ORIGIN.includes(requestOrigin)) {
      return callback(null, true);
    }
    return callback(new Error('CORS policy error: Origin not allowed'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
};

app.use(cors(corsOptions));
app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(sanitizeInput);

// =========================================================================
// 2. GLOBAL RATE LIMITER & SECURITY GUARDS
// =========================================================================
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 Minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: false,
    message: 'Too many requests, please take a break and try again later.',
    errorCode: 'TOO_MANY_REQUESTS'
  }
});

app.use('/', ipGuard);
app.use('/api/', globalLimiter);

// =========================================================================
// 3. ROOT API INFORMATION ENDPOINT
// =========================================================================
app.get('/', (_req: Request, res: Response) => {
  return ApiResponse.success(res, 'Nexius MD API is running', {
    name: 'Nexius MD API',
    version: '1.0.0',
    status: 'UP',
    environment: env.NODE_ENV || 'development',
    apiVersion: 'v1',
    uptimeSeconds: Math.floor(process.uptime())
  });
});

// =========================================================================
// 4. SYSTEM HEALTH & MONITORING ENDPOINT (DRIZZLE ORM)
// =========================================================================
app.get('/health', async (_req: Request, res: Response) => {
  try {
    // Ping PostgreSQL using Drizzle ORM native sql driver query
    await db.execute(sql`SELECT 1`);

    return ApiResponse.success(res, 'System operational and healthy', {
      status: 'UP',
      database: 'CONNECTED',
      uptimeSeconds: Math.floor(process.uptime())
    });
  } catch (err) {
    return ApiResponse.error(
      res,
      'Health check failed: Database unreachable',
      503,
      'SERVICE_UNAVAILABLE',
      env.NODE_ENV === 'development' ? (err instanceof Error ? err.message : err) : null
    );
  }
});

// =========================================================================
// 5. APPLICATION API V1 ROUTES
// =========================================================================
app.use('/api/v1', v1Router);

// =========================================================================
// 6. GLOBAL 404 UNHANDLED ROUTE CATCHER
// =========================================================================
app.use((_req: Request, _res: Response, next: NextFunction) => {
  next(
    ApiError.notFound(
      'Requested route or resource does not exist',
      'ROUTE_NOT_FOUND'
    )
  );
});

// =========================================================================
// 7. CENTRALIZED ENTERPRISE GLOBAL ERROR HANDLER
// =========================================================================
app.use(globalErrorHandler);

export default app;