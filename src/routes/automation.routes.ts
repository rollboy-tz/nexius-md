// path: src/routes/automation.routes.ts

import { Router } from 'express';
import { AutomationController, TemplateController } from '../controllers/automation.controller.js';
import { requirePermission } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate-request.middleware.js';
import { automationSchema } from '../schemas/automation.schema.js';

/**
 * Both routers are mounted by organization.routes.ts on the tenant router, so authenticate and
 * requireOrganization() have already run once.
 *
 *   /organizations/:organizationId/templates     saved messages (MEMBER and up may write them)
 *   /organizations/:organizationId/automations   things a channel does by itself (ADMIN and up)
 *
 * Automations are stricter on purpose: they send to many people without anyone pressing a button.
 */

export const templateRoutes = Router({ mergeParams: true });

templateRoutes.get('/', requirePermission('channel:read'), validate(automationSchema.listTemplates), TemplateController.list);
templateRoutes.post('/', requirePermission('message:send'), validate(automationSchema.createTemplate), TemplateController.create);
templateRoutes.get('/:templateId', requirePermission('channel:read'), validate(automationSchema.getTemplate), TemplateController.get);
templateRoutes.patch('/:templateId', requirePermission('message:send'), validate(automationSchema.updateTemplate), TemplateController.update);
templateRoutes.delete('/:templateId', requirePermission('message:send'), validate(automationSchema.removeTemplate), TemplateController.remove);

export const automationRoutes = Router({ mergeParams: true });

automationRoutes.get('/', requirePermission('channel:read'), validate(automationSchema.listAutomations), AutomationController.list);
automationRoutes.post('/', requirePermission('channel:manage'), validate(automationSchema.createAutomation), AutomationController.create);
automationRoutes.get('/:automationId', requirePermission('channel:read'), validate(automationSchema.getAutomation), AutomationController.get);
automationRoutes.patch('/:automationId', requirePermission('channel:manage'), validate(automationSchema.updateAutomation), AutomationController.update);
automationRoutes.delete('/:automationId', requirePermission('channel:manage'), validate(automationSchema.removeAutomation), AutomationController.remove);