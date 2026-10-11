// path: src/controllers/automation.controller.ts

import { ApiResponse } from '../utils/api-response.util.js';
import { getAuthUser, getOrgContext } from '../middlewares/auth.middleware.js';
import { bodyOf, paramsOf, queryOf } from '../middlewares/validate-request.middleware.js';
import type {
  AutomationParams,
  CreateAutomationBody,
  CreateTemplateBody,
  ListAutomationsQuery,
  TemplateParams,
  UpdateAutomationBody,
  UpdateTemplateBody,
} from '../schemas/automation.schema.js';
import { AutomationService } from '../services/automation.service.js';
import { catchAsync } from '../utils/catch-async.util.js';
import { metaOf } from '../utils/request-meta.js';

/* ============================================================================
 * Saved messages: text kept ready for automations, formatting preserved exactly.
 * Mounted at /organizations/:organizationId/templates
 * ========================================================================== */

export const TemplateController = {
  list: catchAsync(async (req, res) => {
    const { organizationId } = getOrgContext(req);
    return ApiResponse.success(res, 'Saved messages.', await AutomationService.listTemplates(organizationId));
  }),

  get: catchAsync(async (req, res) => {
    const { organizationId } = getOrgContext(req);
    const { templateId } = paramsOf<TemplateParams>(req);

    return ApiResponse.success(res, 'Saved message.', await AutomationService.getTemplate(organizationId, templateId));
  }),

  create: catchAsync(async (req, res) => {
    const { organizationId } = getOrgContext(req);
    const template = await AutomationService.createTemplate(organizationId, getAuthUser(req).userId, bodyOf<CreateTemplateBody>(req), metaOf(req));

    return ApiResponse.success(res, 'Message saved.', template);
  }),

  update: catchAsync(async (req, res) => {
    const { organizationId } = getOrgContext(req);
    const { templateId } = paramsOf<TemplateParams>(req);

    const template = await AutomationService.updateTemplate(
      organizationId,
      getAuthUser(req).userId,
      templateId,
      bodyOf<UpdateTemplateBody>(req),
      metaOf(req),
    );
    return ApiResponse.success(res, 'Saved message updated.', template);
  }),

  /** Refused while an automation still uses it. */
  remove: catchAsync(async (req, res) => {
    const { organizationId } = getOrgContext(req);
    const { templateId } = paramsOf<TemplateParams>(req);

    await AutomationService.removeTemplate(organizationId, getAuthUser(req).userId, templateId, metaOf(req));
    return ApiResponse.success(res, 'Saved message deleted.', null);
  }),
};

/* ============================================================================
 * Automations: things a channel does by itself, always through the queue and the safety rules.
 * Mounted at /organizations/:organizationId/automations
 * ========================================================================== */

export const AutomationController = {
  list: catchAsync(async (req, res) => {
    const { organizationId } = getOrgContext(req);
    return ApiResponse.success(res, 'Automations.', await AutomationService.listAutomations(organizationId, queryOf<ListAutomationsQuery>(req)));
  }),

  get: catchAsync(async (req, res) => {
    const { organizationId } = getOrgContext(req);
    const { automationId } = paramsOf<AutomationParams>(req);

    return ApiResponse.success(res, 'Automation.', await AutomationService.getAutomation(organizationId, automationId));
  }),

  create: catchAsync(async (req, res) => {
    const { organizationId } = getOrgContext(req);
    const automation = await AutomationService.createAutomation(organizationId, getAuthUser(req).userId, bodyOf<CreateAutomationBody>(req), metaOf(req));

    return ApiResponse.success(res, 'Automation created.', automation);
  }),

  update: catchAsync(async (req, res) => {
    const { organizationId } = getOrgContext(req);
    const { automationId } = paramsOf<AutomationParams>(req);

    const automation = await AutomationService.updateAutomation(
      organizationId,
      getAuthUser(req).userId,
      automationId,
      bodyOf<UpdateAutomationBody>(req),
      metaOf(req),
    );
    return ApiResponse.success(res, 'Automation updated.', automation);
  }),

  remove: catchAsync(async (req, res) => {
    const { organizationId } = getOrgContext(req);
    const { automationId } = paramsOf<AutomationParams>(req);

    await AutomationService.removeAutomation(organizationId, getAuthUser(req).userId, automationId, metaOf(req));
    return ApiResponse.success(res, 'Automation deleted.', null);
  }),
};