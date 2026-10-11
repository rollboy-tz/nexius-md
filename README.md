# Auth: session, service, middleware

Faili kubwa zilizo tayari: `auth-session.service.ts`, `auth.service.ts`, `auth.middleware.ts`
(na `token.service.ts` ya awali). Faili ndogo zinazohitajika ziko hapa chini ili uziweke mwenyewe.

## 1. Mahitaji

```bash
npm i argon2 jsonwebtoken
npm i -D @types/jsonwebtoken
```

- `.env`: `JWT_SECRET` angalau herufi 32 (`openssl rand -base64 48`). `JWT_REFRESH_SECRET` haihitajiki tena, refresh token sasa ni ya nasibu na haisainiwi.
- `constants/status-codes.ts`: ongeza `TOO_MANY_REQUESTS: 429`.
- `CacheService` inahitaji `get<T>(key)` (irudishe `null`/`undefined` isipopatikana), `set(key, value, ttlSeconds)`, `del(key)`.
- `OrganizationService` (faili linalofuata) lazima itoe hizi mbili, ambazo `auth.service.ts` inazitumia:

```ts
static createWithOwner(tx: Tx, input: { name: string; userId: string }): Promise<Organization>;
static consumeInviteInTx(
  tx: Tx,
  input: { token: string; email: string; userId: string },
): Promise<{ organizationId: string; role: OrgRole }>;
```

## 2. `src/auth/permissions.ts`

```ts
import type { OrgRole, PlatformRole } from '../db/schema.js';

export type Permission =
  | 'org:read' | 'org:update' | 'org:delete' | 'org:transfer'
  | 'member:read' | 'member:invite' | 'member:update_role' | 'member:remove'
  | 'channel:read' | 'channel:create' | 'channel:manage' | 'channel:delete'
  | 'message:send' | 'apikey:manage' | 'audit:read';

const RANK: Record<OrgRole, number> = { VIEWER: 1, MEMBER: 2, ADMIN: 3, OWNER: 4 };

const VIEWER: readonly Permission[] = ['org:read', 'member:read', 'channel:read'];
const MEMBER: readonly Permission[] = [...VIEWER, 'message:send'];
const ADMIN: readonly Permission[] = [
  ...MEMBER, 'org:update', 'member:invite', 'member:update_role', 'member:remove',
  'channel:create', 'channel:manage', 'channel:delete', 'apikey:manage', 'audit:read',
];
const OWNER: readonly Permission[] = [...ADMIN, 'org:delete', 'org:transfer'];

const PERMISSIONS: Record<OrgRole, ReadonlySet<Permission>> = {
  VIEWER: new Set(VIEWER), MEMBER: new Set(MEMBER), ADMIN: new Set(ADMIN), OWNER: new Set(OWNER),
};

export const hasOrgPermission = (role: OrgRole, permission: Permission): boolean =>
  PERMISSIONS[role].has(permission);

/** OWNER is never assigned or invited; it moves only through transferOwnership. */
export const ASSIGNABLE_ROLES = ['ADMIN', 'MEMBER', 'VIEWER'] as const satisfies readonly OrgRole[];
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

/** You can only manage people ranked strictly below you. */
export const canManageMember = (actor: OrgRole, target: OrgRole): boolean => RANK[actor] > RANK[target];
/** You can only hand out roles ranked strictly below your own. */
export const canAssignRole = (actor: OrgRole, role: OrgRole): boolean => RANK[actor] > RANK[role];

const PLATFORM_RANK: Record<PlatformRole, number> = { USER: 0, SUPPORT: 1, SUPER_ADMIN: 2 };
export const hasPlatformRole = (role: PlatformRole, minimum: PlatformRole): boolean =>
  PLATFORM_RANK[role] >= PLATFORM_RANK[minimum];
```

## 3. `src/services/password.service.ts`

Argon2id (viwango vya OWASP). Hash za bcrypt za zamani bado zinathibitishwa na kubadilishwa
kuwa argon2id mtumiaji anapoingia, kwa hiyo hakuna migration ya nywila.

```ts
import argon2 from 'argon2';
import bcrypt from 'bcryptjs';
import { ApiError } from '../utils/api.error.js';
import { randomToken } from '../utils/crypto.util.js';

const OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

let dummyHash: Promise<string> | null = null;
const getDummyHash = (): Promise<string> => (dummyHash ??= argon2.hash(randomToken(16), OPTIONS));

export function validatePasswordPolicy(password: string, email?: string): void {
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) {
    throw ApiError.badRequest('Password must be between 10 and 128 characters.', 'WEAK_PASSWORD');
  }
  if (email && password.toLowerCase() === email.toLowerCase()) {
    throw ApiError.badRequest('Password must not be your email address.', 'WEAK_PASSWORD');
  }
}

export class PasswordService {
  public static hash(password: string): Promise<string> {
    return argon2.hash(password, OPTIONS);
  }

  /** With no stored hash it still does the work of a real comparison, so timing reveals nothing. */
  public static async verify(
    storedHash: string | null | undefined,
    password: string,
  ): Promise<{ valid: boolean; needsRehash: boolean }> {
    if (!storedHash) {
      await argon2.verify(await getDummyHash(), password).catch(() => false);
      return { valid: false, needsRehash: false };
    }

    if (storedHash.startsWith('$2')) {
      const valid = await bcrypt.compare(password, storedHash);
      return { valid, needsRehash: valid };
    }

    try {
      const valid = await argon2.verify(storedHash, password);
      return { valid, needsRehash: valid && argon2.needsRehash(storedHash, OPTIONS) };
    } catch {
      return { valid: false, needsRehash: false };
    }
  }
}
```

## 4. `src/types/express.d.ts` (futa ile ya zamani inayoingiza `@prisma/client`)

```ts
import type { AuthUser, OrgContext } from '../services/auth-session.service.js';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      org?: OrgContext;
      organizationId?: string;
    }
  }
}

export {};
```

Ondoa pia `declare global` iliyo ndani ya `auth.middleware.ts` ya zamani. Sasa ipo sehemu moja tu.

## 5. Jinsi ya kuunganisha kwenye routes

```ts
router.post('/auth/login', loginLimiter, catchAsync(AuthController.login));      // public
router.get('/me', authenticate, catchAsync(MeController.get));                   // mtumiaji tu

router.post(
  '/organizations/:organizationId/members/invites',
  authenticate,
  requireOrganization(),
  requirePermission('member:invite'),
  catchAsync(OrgController.invite),
);

router.get('/admin/organizations', authenticate, requirePlatformRole('SUPPORT'), catchAsync(AdminController.listOrgs));
```

Kwenye controller: `const user = getAuthUser(req); const org = getOrgContext(req);` (hakuna `!`).
Kwa `RequestMeta`: `{ ipAddress: req.ip, userAgent: req.get('user-agent'), requestId: req.get('x-request-id') }`.
Weka `app.set('trust proxy', ...)` ipasavyo ili `req.ip` iwe ya mteja, si ya proxy.

## 6. Mambo ya kujaribu kabla ya kuamini

1. Verify email bila token halali inashindwa; token inatumika mara moja tu.
2. Refresh kwa wakati mmoja kutoka tabs mbili: zote zinapata jozi ile ile (ndani ya sekunde 30).
3. Refresh token ya zamani baada ya sekunde 30: session inafutwa (`TOKEN_REUSE_DETECTED`).
4. Logout ya kifaa kimoja: access token yake inakataliwa mara moja, vifaa vingine vinaendelea.
5. Kusimamisha mtumiaji: `revokeAllUserSessions` + `invalidateUser`, na ombi lake lililofuata linapata 401.
6. `/organizations/<uuid ya mtu mwingine>` inarudisha 404, si 403.

---

# Kuunganisha channel, admin na socket (sehemu ya mwisho)

Faili kubwa zilizoongezwa: `organization.service.ts`, `channel.service.ts`, `admin.service.ts`, `realtime/socket-auth.ts`.
Mabadiliko madogo ya faili zako zilizopo ni haya. Hakuna kitu kingine kinachohitaji kuguswa.

## 7. `server.ts`

```ts
import { registerSocketAuth, canAccessChannel } from './realtime/socket-auth.js';
import { ChannelService } from './services/channel.service.js';
import { checkDatabase, closeDatabase } from './config/database.js';
import { closeRedis } from './config/redis.js';

// Baada ya bindLogSocketServer(io):
const closeSocketAuth = registerSocketAuth(io);
```

`join_session`: baada ya kukagua `isValidSessionId` na rate limit, kabla ya `socket.join`:

```ts
if (!(await canAccessChannel(socket, sessionId, 'channel:read'))) {
  return reply(ack, { ok: false, error: 'FORBIDDEN' });
}
```

`clear_logs`: acha ukaguzi wa `socket.rooms.has(sessionId)` na uongeze:

```ts
if (!(await canAccessChannel(socket, sessionId, 'channel:manage'))) {
  return reply(ack, { ok: false, error: 'FORBIDDEN' });
}
```

`listen` callback: badala ya `sessionManager.restoreActiveSessions()`:

```ts
await checkDatabase();
ChannelService.startStatusSync();
await ChannelService.restoreAll();
```

`gracefulShutdown`: **mstari wa kwanza kabisa** ndani ya `try` (kabla ya `shutdownAllConnections`):

```ts
ChannelService.beginShutdown(); // vinginevyo STOPPED inaandikwa na hakuna kitakachorudishwa baada ya restart
```

na mwishoni, kabla ya `process.exit`: `await closeSocketAuth(); await closeDatabase(); await closeRedis();`

## 8. `bailey.service.ts`

```ts
import { appEvents } from './session-events.js';

function emitSessionStatus(sessionId: string, payload: SessionStatusPayload): void {
  io.to(sessionId).emit('session_status', { sessionId, ...payload, timestamp: new Date().toISOString() });
  appEvents.emitChannelStatus(sessionId, {
    state: payload.state,
    message: payload.message,
    phoneNumber: payload.phoneNumber,
    profile: payload.profile ?? null,
  });
}
```

`sessionId` ya Baileys sasa ni `channels.id` (UUID). Inapita regex yako ya sasa, hakuna mabadiliko mengine.

## 9. `session.manager.ts` (sasa inaitwa `wa-session.manager.ts`, tazama faili jipya, usifuate maelekezo haya ya zamani)

- Futa `restoreActiveSessions` yote (imehamia `ChannelService.restoreAll`, kuzuia circular import).
- Futa `import { prisma }` / `db` ya zamani na utumie:

```ts
import { db } from '../config/database.js';
import { channelMessages } from '../db/schema.js';
```

- `SendMessagePayload` ipate `organizationId: string` (controller inaitoa kutoka `getOrgContext(req)` baada ya `ChannelService.get`).
- Kuhifadhi ujumbe, na kushindwa kuhifadhi kusifanye ujumbe uliotumwa uonekane umeshindwa:

```ts
try {
  await db
    .insert(channelMessages)
    .values({
      organizationId,
      channelId: sessionId,
      externalMessageId: sentMsg.key.id,
      direction: 'OUTBOUND',
      fromAddress: senderJid,
      toAddress: destinationJid,
      content: text,
    })
    .onConflictDoNothing();
} catch (err) {
  console.error('⚠️ Message was sent but could not be stored:', err);
}
```

## 10. Routes zinazohitajika

| Njia | Middleware | Huduma |
|---|---|---|
| `GET/POST /organizations/:organizationId/channels` | `authenticate, requireOrganization(), requirePermission('channel:read' / 'channel:create')` | `ChannelService.list / create` |
| `POST .../channels/:channelId/initiate` | `... requirePermission('channel:manage')` | `await ChannelService.get(orgId, channelId)` kisha `sessionManager.getOrCreateSession(channelId)` |
| `POST .../channels/:channelId/pair` | sawa | `ChannelService.get` kisha `sessionManager.requestPairingCode(channelId, phone)` |
| `DELETE .../channels/:channelId` | `requirePermission('channel:delete')` | `ChannelService.remove` |
| `POST /invitations/accept` | `authenticate` | `OrganizationService.acceptInvite` |
| `GET /invitations/preview?token=` | public + rate limit kali | `OrganizationService.previewInvite` |
| `/organizations/:organizationId/members...`, `/invites...` | `requirePermission('member:*')` | `OrganizationService.*` |
| `/admin/**` (kusoma) | `authenticate, requirePlatformRole('SUPPORT')` | `AdminService.*` |
| `/admin/**` (kuandika) | `authenticate, requirePlatformRole('SUPER_ADMIN')` | `AdminService.*` |

Controller ya kila mmoja: `ChannelService.get(orgId, channelId)` **kabla** ya kugusa session. Hiyo ndiyo
kinga dhidi ya kutumia `channelId` ya organization nyingine.

## 11. Frontend

- `sessionId` kwenye `SessionPage` iwe `channel.id` (si user id). Ukurasa uchague channel ya organization hai.
- Endpoints zibadilike kuwa `/organizations/:orgId/channels/:channelId/initiate|pair`.
- `socket.service.ts`: kwenye `connect_error` yenye ujumbe `UNAUTHORIZED`, omba token mpya (refresh) kisha `socket.connect()`.
  Socket inajifunga kila saa kwa makusudi, na itarudi kwa token mpya.

## 12. Kuanzisha SUPER_ADMIN wa kwanza

Kamwe sio kupitia API. Mara moja kwa SQL, baada ya kujisajili na kuthibitisha email yako:

```sql
UPDATE users SET platform_role = 'SUPER_ADMIN' WHERE email = 'wewe@mfano.com';
```

Washa MFA kwa akaunti za staff kabla ya production (bado haipo kwenye kodi hii).

## 13. Data ya zamani

Kama hakuna wateja halisi bado, anza upya (futa jedwali, `drizzle-kit generate`, `migrate`). Ni salama zaidi.
Kama kuna data: `users.role` -> `platform_role` (SUPER_ADMIN pekee) na `organization_members` (mtu wa kwanza wa organization
anakuwa OWNER, wengine kwa role zao); `email_verified` -> `email_verified_at`; `whatsapp_sessions` -> `channels`
(na ubadilishe majina ya folda za auth kuwa `channels.id`). Sessions na refresh tokens za zamani haziwezi kuhamishwa: watumiaji waingie tena.

## 14. Kinachobaki kwa kiwango cha enterprise kamili (kwa mpangilio wa umuhimu)

1. **Baileys auth state kwenye database iliyosimbwa** (`channel_credentials`, `encryptJson`) badala ya folda ya faili. Ndiyo funguo za akaunti za wateja, na faili za diski zinapotea kwenye container.
2. **Worker per channel**: kila session ya WhatsApp ni muunganisho mmoja wenye hali. Ukiwa na server nyingi, tumia lease ya Redis (`SET channel:lease:<id> <instance> NX EX 30`) ili session moja isiendeshwe mara mbili, na `@socket.io/redis-adapter` ili logs zifike popote.
3. **MFA (TOTP)** kwa staff na owners, na hatua ya "re-authenticate" kabla ya matendo hatari.
4. **Rate limit kwa Redis** kwenye `/auth/*` na `/invitations/*` (kwa IP), na `messagesPerDay` kwa kila organization (kikomo kipo kwenye `plans.ts`, utekelezaji haupo).
5. **Haki za database kwa `audit_logs`**: toa INSERT na SELECT tu kwa role ya app, ili logs zisibadilishwe hata ukivamiwa.
6. **Kazi ya usafi**: futa `auth_sessions` zilizoisha, `verification_tokens` zilizotumika, na ufute kabisa organizations zilizofutwa baada ya siku za uhifadhi.
7. **Mfumo wa kutuma barua wenye foleni na kujaribu tena** badala ya `mail.service.ts` ya majaribio (production inakataa kwa makusudi hadi uuweke).

---

# Cookies, silent refresh, validation na auth routes

Faili mpya: `utils/auth-cookies.ts`, `middlewares/auth.middleware.ts` (imeandikwa upya), `middlewares/validate-request.middleware.ts`,
`middlewares/rate-limit.middleware.ts`, `schemas/auth.schema.ts`, `schemas/wa-session.schema.ts`,
`controllers/auth.controller.ts`, `routes/auth.routes.ts`. `routes/wa-session.routes.ts` imepewa `validate(...)`.

## 15. Mahitaji

```bash
npm i zod cookie-parser
npm i -D @types/cookie-parser
```

`app.ts`, kwa mpangilio huu:

```ts
import cookieParser from 'cookie-parser';

app.set('trust proxy', 1); // idadi ya proxies mbele yako (nginx/Cloudflare = 1 au 2). Bila hii req.ip si ya mteja.
app.use(cors({
  origin: allowedOrigins,            // orodha kamili, si '*'
  credentials: true,                 // inahitajika ili browser itume cookies
  exposedHeaders: ['X-Token-Refreshed', 'X-Token-Expired', 'Retry-After', 'RateLimit-Limit', 'RateLimit-Remaining'],
}));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/organizations/:organizationId/channels', waSessionRoutes);
```

`exposedHeaders` ni muhimu: bila hiyo browser inaficha `X-Token-Refreshed` kwa JavaScript, na interceptor haitaiona.
Futa mount ya zamani ya `/api/v1/sessions` (haikuwa na `authenticate`).

`.env` (zote hiari, chaguo-msingi ni salama):

```
COOKIE_SAME_SITE=lax     # lax | strict | none
COOKIE_DOMAIN=           # tupu isipokuwa unahitaji kushiriki kati ya subdomains
```

`COOKIE_SAME_SITE`: `lax` kama frontend na API ziko site moja (`app.mfano.com` na `api.mfano.com`). Kama ziko site tofauti kabisa
(`mfano.vercel.app` na `api.mfano.com`), tumia `none` (inahitaji HTTPS). Hapo ukaguzi wa Origin unakuwa kinga yako kuu ya CSRF.

## 16. `types/express.d.ts` (sasisho)

```ts
import type { AuthSource } from '../middlewares/auth.middleware.js';
import type { AuthUser, OrgContext } from '../services/auth-session.service.js';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      org?: OrgContext;
      organizationId?: string;
      authSource?: AuthSource;
    }
  }
}

export {};
```

## 17. Interceptor ya axios (mfano, kwa web)

Browser haihitaji kuweka token popote. Inachohitaji ni `withCredentials`, na kujua nini kimetokea:

```ts
apiClient.defaults.withCredentials = true;

apiClient.interceptors.response.use(
  (response) => {
    if (response.headers['x-token-refreshed'] === 'true') {
      // Cookies zilifanywa upya kimya kimya. Hakuna cha kufanya; hiari: sasisha hali ya mtumiaji.
    }
    return response;
  },
  (error) => {
    const code = error.response?.data?.error?.code;
    // Kikao kimeisha kabisa (refresh cookie imekufa, imefutwa, au akaunti imesimamishwa): nenda login.
    if (error.response?.status === 401 && code !== 'REFRESH_RETRY') redirectToLogin();
    return Promise.reject(error);
  },
);
```

`REFRESH_RETRY` inamaanisha tabs mbili zilirefresh kwa wakati mmoja. Jaribu tena ombi mara moja, usimtoe mtu nje.
Ondoa kabisa `localStorage.getItem('auth_token')` na `Authorization` header kwenye web client.

Socket.IO kwenye web: handshake haisomi cookies kwa sasa (`socket-auth.ts` inasoma `auth.token`).
Chaguo: weka `withCredentials: true` kwenye socket client, na `socket-auth.ts` isome cookie `ACCESS_COOKIE`
kutoka `socket.handshake.headers.cookie` pale `auth.token` haipo. Niambie nikiandike.

## 18. Mobile

- Kila ombi: header `X-Client-Platform: mobile`.
- Login / verify-email / refresh: tokens zinarudi kwenye `body` (na hakuna cookies).
- Kila ombi lenye ulinzi: `Authorization: Bearer <accessToken>`.
- Access token ikiisha: jibu ni `401` yenye `error.code = "ACCESS_TOKEN_EXPIRED"` na header `X-Token-Expired: true`.
  App inaita `POST /auth/refresh` na `{ "refreshToken": "..." }`, inapata jozi mpya kwenye body, kisha inarudia ombi.
  Rudia ombi **mara moja tu**; kama refresh yenyewe inashindwa, mtoe mtu kwenye login.
- Refresh token ihifadhiwe Keychain / Keystore, si AsyncStorage.

---

# Organizations, channels na jinsi ya kupata `channelId` ya kujaribu

## 19. Mount (badilisha mistari ya zamani ya routes)

```ts
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/organizations', organizationRoutes); // inajumuisha /:organizationId/channels/** na session routes
app.use('/api/v1/invitations', invitationRoutes);     // import { invitationRoutes } from './routes/organization.routes.js'
```

Futa mount ya `/api/v1/organizations/:organizationId/channels` ya `waSessionRoutes` na ya `/api/v1/sessions`.
`authenticate` na `requireOrganization()` sasa zinaendeshwa MARA MOJA kwenye tenant router; zikirudiwa, silent refresh ingeendeshwa mara mbili.

## 20. Njia ya haraka ya kujaribu session (curl, cookies jar)

```bash
B=http://localhost:5000/api/v1
H='-H Content-Type:application/json -H Origin:http://localhost:5173'

# 1. jisajili, thibitisha email (kiungo kinachapishwa kwenye console ya server kwenye dev), ingia
curl -c jar $H -X POST $B/auth/register -d '{"fullName":"Test User","email":"test@mfano.com","password":"nenosiri-refu-123","businessName":"Duka Langu"}'
curl -c jar $H -X POST $B/auth/verify-email -d '{"token":"<token kutoka console>"}'

# 2. pata organizationId
curl -b jar $B/auth/me                       # data.organizations[0].id

# 3. unda channel, chukua data.id
curl -b jar -c jar $H -X POST $B/organizations/<orgId>/channels -d '{"displayName":"Namba ya Duka"}'

# 4. anzisha session na uombe pairing code
curl -b jar -c jar $H -X POST $B/organizations/<orgId>/channels/<channelId>/initiate -d '{}'
curl -b jar -c jar $H -X POST $B/organizations/<orgId>/channels/<channelId>/pair -d '{"phoneNumber":"255712345678"}'
```

`<channelId>` hiyo ndiyo `sessionId` ya SessionPage na chumba cha logs za Socket.IO.
(Kumbuka: Socket.IO ya web bado inasoma `auth.token`; tazama sehemu ya 17.)

---

# Ujumbe, foleni, usalama wa namba na automations

Faili mpya: `types/message.types.ts`, `config/safety.ts`, `utils/{whatsapp-format,safe-fetch,jid.util,zoned-time}.ts`,
`services/{humanizer,outbound-policy,outbound,message,inbound,automation}.service.ts`, `queue/outbound.{queue,worker}.ts`,
`schemas/{message,automation}.schema.ts`, `controllers/{message,automation}.controller.ts`, `routes/{message,automation}.routes.ts`.
Zilizobadilishwa: `db/schema.ts`, `wa-session.manager.ts` (haitumi tena ujumbe), `channel.*` (settings), `organization.routes.ts`.

## 21. Mahitaji

```bash
npm i bullmq undici
```

BullMQ inauliza Redis mara kwa mara. Kwenye Upstash ya "lipa kwa amri" gharama itapanda; tumia Redis ya bei maalum au ya kwako kwa foleni.
`.env`: `OUTBOUND_WORKER_CONCURRENCY=10` (hiari). Redis ya kawaida (`config/redis.ts`) haibadiliki: foleni inatengeneza miunganisho yake.

## 22. `bailey.service.ts`: kuunganisha upokeaji

Ndani ya `createSocket`, mara tu baada ya `const sock = makeWASocket(config);`:

```ts
import { attachInboundHandlers } from './inbound.service.js';
// ...
attachInboundHandlers(sock, session.sessionId);
```

## 23. `server.ts`

```ts
import { startOutboundWorker, stopOutboundWorker } from './queue/outbound.worker.js';
import { closeOutboundQueue } from './queue/outbound.queue.js';
import { AutomationService } from './services/automation.service.js';

// bootstrap(): baada ya ChannelService.startStatusSync(), kabla ya httpServer.listen
startOutboundWorker();
AutomationService.startScheduler();

// gracefulShutdown(): mara tu baada ya ChannelService.beginShutdown(), KABLA ya shutdownAllConnections()
AutomationService.stopScheduler();
await stopOutboundWorker();   // hakuna ujumbe unaotumwa katikati ya zimisha
await closeOutboundQueue();
```

## 24. Migration ya database

`drizzle-kit generate`, kisha SOMA SQL kabla ya kuendesha. Mabadiliko: `channel_messages` (aina mpya, `external_message_id` inaweza kuwa tupu,
`delivery_status`, `entities`, `links`, `mentions`, `media`, `payload`, `idempotency_key`...), `channels.first_connected_at`, na jedwali
`message_templates`, `automations`, `channel_opt_outs`. Kama una ujumbe wa zamani:

```sql
UPDATE channel_messages SET delivery_status = 'SENT', sent_at = created_at WHERE direction = 'OUTBOUND';
UPDATE channels SET first_connected_at = COALESCE(last_connected_at, created_at) WHERE first_connected_at IS NULL AND last_connected_at IS NOT NULL;
```

La pili ni muhimu: bila hilo namba za zamani zingeonekana mpya na kupata kikomo cha siku ya kwanza.

## 25. Endpoints (zote chini ya `/api/v1/organizations/:organizationId`)

| Njia | Ruhusa | Kazi |
|---|---|---|
| `POST /channels/:channelId/messages` | `message:send` | Kukubali ujumbe (202). Kichwa `Idempotency-Key` kinazuia kurudia |
| `GET /channels/:channelId/messages` | `channel:read` | Orodha (mpya kwanza), `?before=`, `?deliveryStatus=`, `?direction=` |
| `GET/DELETE /channels/:channelId/messages/:messageId` | `channel:read` / `message:send` | Hali / kughairi (kabla ya kuanza kutumwa) |
| `PATCH /channels/:channelId/settings` | `channel:manage` | `timezone`, `workingHours`, `allowColdOutreach`, `humanize`, `dailyLimit` |
| `GET/POST/PATCH/DELETE /templates` | `channel:read` / `message:send` | Jumbe zilizohifadhiwa (muundo wa WhatsApp unahifadhiwa kama ulivyo) |
| `GET/POST/PATCH/DELETE /automations` | `channel:read` / `channel:manage` | `BROADCAST`, `STATUS_POST`, `STATUS_VIEW` |

Mfano wa automation ya kutuma kwenye groups (kila siku karibu 09:30, kila group kwa tofauti ya sekunde 40 hadi 120):

```json
{
  "type": "BROADCAST", "name": "Bidhaa za wiki", "channelId": "<id>",
  "config": {
    "templateId": "<id>",
    "targets": ["120363023847@g.us", "120363011111@g.us"],
    "schedule": { "kind": "DAILY", "times": ["09:30"], "jitterMinutes": 20, "timezone": "Africa/Dar_es_Salaam" },
    "staggerSeconds": { "min": 40, "max": 120 }
  }
}
```

## 26. Mipaka ya toleo hili (kwa uaminifu)

- Picha za kuingia: tunahifadhi maelezo yake (aina, ukubwa, vipimo, alama ya kidole, maelezo), si picha yenyewe. `storageKey` ipo kwa ajili ya S3/R2 baadaye.
- `AUTO_REPLY` (kujibu baadhi ya ujumbe) imehifadhiwa kwenye aina lakini haijatekelezwa.
- Hadhira ya status ni "watu walioandika kwa namba hii hivi karibuni", si orodha nzima ya simu (hatuna ufikiaji wake).
- Video, sauti na video-duara hazishughulikiwi: hazisomwi wala kuhifadhiwa.
- Hakikisha kwenye Baileys uliyosakinisha: `sendMessage` ya `status@broadcast` inakubali `statusJidList`, `backgroundColor`, `font`;
  `normalizeMessageContent` inasafirishwa; na `remoteJidAlt` ipo kwa mazungumzo ya `@lid`. Majina haya yamebadilika kati ya matoleo.
- Kuiga tabia ya binadamu kunapunguza hatari, hakuiondoi. Kinga yenye nguvu zaidi ni sheria za `outbound-policy.service.ts`.

---

# Socket.IO: kuondoa kosa la `UNAUTHORIZED` kwenye web

## 27. Kwa nini linatokea

`socket-auth.ts` inasoma token kutoka `socket.handshake.auth.token`. Web sasa haina token ya kusoma: access token iko kwenye cookie ya
HttpOnly, ambayo JavaScript haioni. `socket.service.ts` ya zamani bado inasoma `localStorage.getItem('auth_token')`, ambayo haipo tena,
kwa hiyo handshake inafika bila chochote na seva inajibu `UNAUTHORIZED`. Seva haina hitilafu: inafanya kazi iliyoagizwa.

Njia ni kuwa handshake itumie cookie ile ile ya HTTP, na kuikinga dhidi ya mashambulizi ya tovuti nyingine.

## 28. Hatua tano

**1. `server.ts`**: ruhusu cookies kwenye Socket.IO (kwa origins zilizoorodheshwa tu; production inakataa `*`).

```ts
cors: { /* origin kama ilivyo */ methods: ['GET', 'POST'], credentials: true },
```

**2. `utils/auth-cookies.ts`**: ongeza chini ya faili.

```ts
/** WebSocket haikingwi na CORS ya browser. Kwa handshake yenye cookie, asili lazima iwe yetu. */
export function isAllowedOrigin(origin: string | undefined): boolean {
  return Boolean(origin) && (allowAnyOrigin || allowedOrigins.includes(origin as string));
}
```

**3. `realtime/socket-auth.ts`**: badilisha `io.use` ya kwanza.

```ts
import { ACCESS_COOKIE, isAllowedOrigin } from '../utils/auth-cookies.js';

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

io.use(async (socket, next) => {
  try {
    const auth: unknown = socket.handshake.auth;
    const fromAuth = typeof auth === 'object' && auth !== null ? (auth as { token?: unknown }).token : undefined;
    let token = typeof fromAuth === 'string' && fromAuth.length > 0 ? fromAuth : undefined; // mobile: header ya token

    if (!token) {
      // Browser: cookie ya HttpOnly. Tovuti yoyote inaweza kuanzisha handshake yenye cookie yako,
      // kwa hiyo asili LAZIMA ithibitishwe (Cross-Site WebSocket Hijacking).
      if (!isAllowedOrigin(socket.handshake.headers.origin)) return next(new Error(UNAUTHORIZED));
      token = cookieValue(socket.handshake.headers.cookie, ACCESS_COOKIE);
    }

    if (!token || token.length > MAX_TOKEN_LENGTH) return next(new Error(UNAUTHORIZED));

    const user = await AuthSessionService.resolveAccessToken(token);
    socket.data.user = { userId: user.userId, sessionId: user.sessionId, platformRole: user.platformRole } satisfies SocketUser;
    next();
  } catch {
    next(new Error(UNAUTHORIZED));
  }
});
```

**4. `socket.service.ts` (frontend)**: usisome tena `localStorage`. Tuma cookies, na hakikisha cookie ni mpya kabla ya kuunganisha.

```ts
const ensureFreshSession = async (): Promise<boolean> => {
  try {
    await http.get('/auth/me'); // authenticate() inarefresh kimya kimya cookie ikiwa imeisha
    return true;
  } catch {
    return false;
  }
};

// ndani ya connect(): kuwa async, na kabla ya io(...)
if (!(await ensureFreshSession())) return redirectToLogin();

this.socket = io(url, {
  withCredentials: true,
  auth: (cb) => cb({}), // web: hakuna token ya kutuma. Mobile: cb({ token: tokenKutokaKeychain })
  // ... chaguo zingine kama zilivyo
});

// ndani ya setupInternalListeners(): jaribu mara moja tu kurekebisha
socket.on('connect_error', async (error: Error) => {
  if (error.message !== 'UNAUTHORIZED' || this.retrying) return;
  this.retrying = true;
  if (await ensureFreshSession()) socket.connect();
  else redirectToLogin();
  this.retrying = false;
});
```

`connect()` kuwa async kunamaanisha `SessionPage` iseme `await socketService.connect()` (au isubiri kwenye `useEffect`).
Kwa nini `/auth/me`? Access cookie inaishi dakika 15 tu, na browser inaifuta ikiisha. Ombi lolote lenye ulinzi linafufua cookie
(silent refresh). Socket inajifunga kila saa kwa makusudi, kwa hiyo bila hatua hii kila kuunganisha upya baada ya dakika 15 kungeshindwa.

**5. Jaribu**: futa tab, ingia, fungua SessionPage. DevTools, Network, WS: handshake inapaswa kuwa `101`, na ukiangalia Request Headers kuna `Cookie: ...nx_at=...`.

## 29. Kama bado kuna `UNAUTHORIZED`: orodha ya kukagua

1. **Cookie ipo?** DevTools, Application, Cookies: `nx_at` (au `__Host-nx_at` kwenye production) na `nx_rt` zipo, `HttpOnly` imewashwa.
2. **`withCredentials: true`** upande wa socket client, na `credentials: true` upande wa seva. Bila pande zote mbili browser haitatuma cookie.
3. **Asili inalingana kikamilifu** na `CORS_ORIGIN`: `https://app.mfano.com` si sawa na `https://app.mfano.com/` wala `http://`. `isAllowedOrigin` inalinganisha maneno yote.
4. **Port tofauti kwenye dev** (5173 na 5000) ni sawa na `SameSite=lax` (ni site moja). Domains tofauti kabisa zinahitaji `COOKIE_SAME_SITE=none` na HTTPS.
5. **Reverse proxy** (nginx, Cloudflare) lazima ipitishe `Upgrade`, `Connection` na `Cookie`. Nginx inahitaji `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`.
6. **`JWT_SECRET`** ile ile kwenye kila instance. Instance mbili zenye siri tofauti zitakataana tokens za kila mmoja.
7. **Access cookie imeisha na hakuna ombi la HTTP lililoifufua**: hatua ya 4 inalitatua. Ukiliona tu baada ya dakika 15, hilo ndilo tatizo.
8. **Imefutwa kwa makusudi**: kuingia upya kutoka kifaa kingine hakufuti, lakini "logout kila mahali" au kusimamishwa kwa akaunti kunafunga socket zote papo hapo. Hilo ni sahihi.

## 30. Logs za Socket.IO: nini kinaonekana na nini hakionekani

| Kitendo | Kwenye logs za moja kwa moja? | Kinarekodiwa wapi |
|---|---|---|
| Matokeo ya `initiate`, `pair`, `disconnect` (SOCKET_CREATED, CONNECTING, PAIRING_CODE, CONNECTED, STOPPED...) | Ndiyo, kutoka `bailey.service` | Hali ya channel (`channels.status`) |
| Kwamba mtu fulani alibonyeza `initiate`, `pair`, `disconnect`, kuunda channel, kubadilisha settings | **Hapana** | `audit_logs` (database) |
| Mistari ya "Starting session…" ya browser | Browser iliyobonyeza tu | Haihifadhiwi |
| Onyo na makosa ya ndani ya Baileys | Ndiyo, ikiwa `createBaileysLogger` imewashwa (`BAILEYS_LOG_LEVEL`, default `warn`) | Logs za server |
| Ujumbe uliowekwa foleni, ukatumwa, ukashindwa, ukacheleweshwa na kanuni (`DAILY_LIMIT`, `PACING`, `OUTSIDE_WORKING_HOURS`) | **Hapana** | `channel_messages` (`deliveryStatus`, `failureReason`) |
| Ujumbe wa kuingia, kujitoa (STOP), status zilizoangaliwa, automations zilizoendeshwa | **Hapana** | `channel_messages`, `channel_opt_outs`, `automations.lastRunAt/lastError` |

Kwa hiyo logs za Socket.IO leo ni **dirisha la muunganisho**, si la shughuli za ujumbe. Bafa yake ni mistari 500 kwa session
na iko kwenye kumbukumbu, kwa hiyo inapotea seva ikizimwa. Rekodi ya kudumu na ya uwajibikaji ni `audit_logs`.

Ukitaka mtumiaji aone kwa nini ujumbe wake haujatoka ("umesubiri: kikomo cha siku", "namba imesimamishwa saa 2"), tuongeze
matukio machache ya `emitSessionLog` kwenye worker. **Kamwe** yasibebe maandishi ya ujumbe, namba za simu wala majina ya groups,
kwa sababu logs zinafika kwenye browser. Hilo ni jambo la kipindi kijacho.