/**
 * Stores (branding media) and which campaigns they are on. GET /getBrandingMedia: gOGig admins see
 * all, everyone else only the accounts they administer. GET /getBrandingMediaTypes: type names only.
 * The API returns every row unpaged, so the tool counts them all and returns the first `limit`.
 */
import { z } from "zod";
import { campaignId, csv, joined, Kit, pageSize, pick } from "./kit";

const STORE_FIELDS = [
  "id", "name", "address", "accountName", "mediaType", "merchantMediaCode",
  "latitude", "longitude", "isMappedToGig", "geofenceRadius",
];

export function registerStoreTools({ api, tool }: Kit): void {
  tool(
    "list_stores",
    "The user's stores (branding media): name, address, type, store code and " +
      "location. Give a campaign to see which stores are on it (isMappedToGig), " +
      "and set mapped to list only the ones on it or only the ones not yet on it. " +
      "Admins of an account see its stores; gOGig admins see all. Returns the " +
      "first `limit` rows and the total, so narrow with search, type or account " +
      "when total is larger.",
    {
      search: z.string().min(2).optional().describe("Part of the store name, address or store code."),
      media_type: csv('Store types, e.g. ["Store"]. See store_types.'),
      account_id: z.string().optional().describe("Only this account's stores."),
      campaign_id: campaignId.optional(),
      mapped: z.boolean().optional().describe("With campaign_id: true = on it, false = not on it yet."),
      has_coordinates: z.boolean().optional().describe("true for stores with a map location only."),
      sort: z.enum(["id", "name", "createdAt"]).optional().describe("Default id."),
      order: z.enum(["asc", "desc"]).optional().describe("Default desc."),
      limit: pageSize(100, 25),
    },
    async (a) => {
      if (a.mapped !== undefined && !a.campaign_id) {
        throw new Error("mapped needs a campaign_id: say which campaign to compare against.");
      }
      const rows: any[] =
        (await api.get("/getBrandingMedia", {
          q: a.search,
          mediaType: joined(a.media_type),
          accountId: a.account_id,
          gigId: a.campaign_id,
          mapped: a.mapped === undefined ? undefined : String(a.mapped),
          hasCoordinates: a.has_coordinates ? "true" : undefined,
          sortBy: a.sort,
          order: a.order,
        })) || [];
      const limit = a.limit ?? 25;
      return { total: rows.length, shown: Math.min(rows.length, limit), stores: rows.slice(0, limit).map((r) => pick(r, STORE_FIELDS)) };
    },
  );

  tool(
    "store_types",
    "Every store type in use, most used first. Call this to get the exact " +
      "spelling before filtering list_stores by type.",
    {},
    async () => api.get("/getBrandingMediaTypes"),
  );
}
