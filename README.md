# Headless SaaS WhatsApp API Engine

A high-performance, multi-tenant WhatsApp REST API engine built with **Node.js**, **TypeScript**, **Express**, **Socket.IO**, **Prisma ORM**, and **PostgreSQL**. Powered by `@whiskeysockets/baileys`, this engine converts monolithic WhatsApp automation logic into a scalable, decoupled backend service capable of managing multiple WhatsApp accounts (tenants) simultaneously with real-time WebSocket event streaming.

---

## Key Features

- **Multi-Tenant Session Management**: Dynamically spin up and maintain isolated WhatsApp sockets per tenant using database-backed session state.
- **Pairing Code Authentication**: Effortlessly link WhatsApp accounts using official phone pairing codes without needing QR terminal interfaces.
- **RESTful API**: Standardized JSON endpoints for sending messages, querying session states, and issuing commands.
- **Real-Time Event Streaming**: WebSockets via `Socket.IO` emit session state changes, system logs, and incoming messages to connected dashboards or external clients.
- **PostgreSQL & Prisma ORM**: Robust persistent layer tracking sessions, log history, and incoming/outgoing message records with type safety.
- **Robust Environment Parsing**: Strict schema validation using **Zod** to prevent runtime configuration failures.
- **ESM Native**: Modern TypeScript implementation aligned with Node.js Next-Gen Module Resolution (`NodeNext`).

---

## System Architecture

```text
               +-------------------------------------------+
               |  External Web Apps / Mobile Clients / GUI |
               +--------------------+----------------------+
                                    |
                        HTTP REST   |   WebSockets (Socket.IO)
                       (API Calls)  |   (Real-time Events/Logs)
                                    v
+-------------------------------------------------------------------------+
|                    HEADLESS WHATSAPP API ENGINE                         |
|                                                                         |
|  +-----------------------+                   +-----------------------+  |
|  |   Express Routers     |                   |   Socket.IO Gateway   |  |
|  +-----------+-----------+                   +-----------+-----------+  |
|              |                                           |              |
|              v                                           v              |
|  +---------------------------------------------------------------+  |
|  |                       Session Manager                         |  |
|  +-------------------------------+-------------------------------+  |
|                                  |                                      |
|               +------------------+------------------+                   |
|               |                                     |                   |
|               v                                     v                   |
|  +-------------------------+           +-------------------------+  |
|  | Baileys Socket Engine   |           |    Prisma Client (DB)   |  |
|  | (Tenant 1, Tenant 2...) |           +------------+------------+  |
|  +-------------------------+                        |                   |
+---------------+-------------------------------------+-------------------+
                |                                     |
                v                                     v
    +-----------------------+             +-----------------------+
    |   WhatsApp Network    |             |  PostgreSQL Database  |
    +-----------------------+             +-----------------------+