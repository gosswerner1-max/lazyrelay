import { Router } from "express";
import type { MerchantOfRecordAdapter } from "../billing/types.js";
import type { PlatformAdapterRegistry } from "../platforms/connect.js";
import { buildSocialAccountsRouter } from "./routes/socialAccounts.routes.js";
import { buildAiRouter } from "./routes/ai.routes.js";
import { buildSupportRouter } from "./routes/support.routes.js";
import { buildBioPageRouter } from "./routes/bioPage.routes.js";
import { buildPublicRouter } from "./routes/public.routes.js";
import { buildGoogleIntegrationsRouter } from "./routes/googleIntegrations.routes.js";
import { buildBrandsRouter } from "./routes/brands.routes.js";
import { buildMediaRouter } from "./routes/media.routes.js";
import { buildPostsRouter } from "./routes/posts.routes.js";
import { buildInboxRouter } from "./routes/inbox.routes.js";
import { buildAnalyticsRouter } from "./routes/analytics.routes.js";
import { buildRecurringSchedulesRouter } from "./routes/recurringSchedules.routes.js";
import { buildBillingRouter } from "./routes/billing.routes.js";
import { buildAccountRouter } from "./routes/account.routes.js";
import { buildTeamRouter } from "./routes/team.routes.js";
import { buildAdminRouter } from "./routes/admin.routes.js";

// Every /api route used to live inline in this one file's buildRouter() —
// ~5,200 lines, 98 route handlers. Split 2026-09-25 into one module per resource
// under http/routes/ (plus routes/shared.ts for helpers more than one module
// needs). This is a pure mechanical extraction: identical paths, identical
// middleware order on every route, identical handler bodies. Each module's
// paths are a disjoint prefix set (no path in one module can match a request
// meant for another), so mounting them as separate sub-routers doesn't change
// which handler any request reaches. Mounted in the order each resource first
// appeared in the original file.
export function buildRouter(morAdapter: MerchantOfRecordAdapter, registry: PlatformAdapterRegistry): Router {
  const router = Router();
  router.use(buildSocialAccountsRouter(registry));
  router.use(buildAiRouter());
  router.use(buildSupportRouter());
  router.use(buildBioPageRouter());
  router.use(buildPublicRouter());
  router.use(buildGoogleIntegrationsRouter());
  router.use(buildBrandsRouter());
  router.use(buildMediaRouter());
  router.use(buildPostsRouter());
  router.use(buildInboxRouter(registry));
  router.use(buildAnalyticsRouter());
  router.use(buildRecurringSchedulesRouter());
  router.use(buildBillingRouter(morAdapter));
  router.use(buildAccountRouter());
  router.use(buildTeamRouter());
  router.use(buildAdminRouter());
  return router;
}
