
import express, { type Application, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { prisma } from './config/database.js';
import { ApiResponse } from './utils/api-response.util.js';
import { ApiError } from './utils/api.error.js';
import { globalErrorHandler } from './middlewares/error.middleware.js';
import v1Router from './routes/v1.routes.js';

const app: Application = express();

// --- 1. ENTERPRISE SECURITY & BASIC MIDDLEWARES ---
app.use(helmet());

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true
}));

app.use(compression());

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// --- 2. GLOBAL RATE LIMITER (DDoS & BRUTE FORCE PROTECTION) ---
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many request, Please take a brake.'
});

app.use('/api/', globalLimiter);

// --- 3. ROOT API INFORMATION ENDPOINT ---
app.get('/', (_req: Request, res: Response) => {
  return ApiResponse.success(res, 'Nexius MD API is running', {
    name: 'Nexius MD API',
    version: '1.0.0',
    status: 'UP',
    environment: process.env.NODE_ENV || 'development',
    apiVersion: 'v1',
    uptimeSeconds: Math.floor(process.uptime())
  });
});

// --- 4. SYSTEM HEALTH & MONITORING ENDPOINT ---
app.get('/health', async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;

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
      err instanceof Error ? err.message : err
    );
  }
});

// --- 5. APPLICATION ROUTES ---
app.use('/api/v1', v1Router);

// --- 6. GLOBAL 404 HANDLER ---
app.use((_req: Request, _res: Response, next) => {
  next(
    ApiError.notFound(
      'Requested route or resource does not exist',
      'ROUTE_NOT_FOUND'
    )
  );
});

// --- 7. CENTRALIZED GLOBAL ERROR HANDLER ---
app.use(globalErrorHandler);

export default app;