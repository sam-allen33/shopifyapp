import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import { apiVersion } from "../shopify.server";

// ---------------------------------------------------------------------------
// Tiny local json() helper
// ---------------------------------------------------------------------------

function json(data: unknown, init?: number | ResponseInit): Response {
  const body = JSON.stringify(data);

  if (typeof init === "number") {
    return new Response(body, {
      status: init,
      headers: { "Content-Type": "application/json" },
    });
  }

  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return new Response(body, {
    ...init,
    headers,
  });
}

// ---------------------------------------------------------------------------
// Environment configuration
// ---------------------------------------------------------------------------

const SHIPWISE_API_URL =
  process.env.SHIPWISE_API_URL ?? "https://api.shipwise.com";

const SHIPWISE_DEBUG_VERBOSE =
  (process.env.SHIPWISE_DEBUG_VERBOSE ?? "false").toLowerCase() === "true";

const SHIPWISE_DEFAULT_HS_CODE =
  process.env.SHIPWISE_DEFAULT_HS_CODE ?? "";

const SHIPWISE_DEFAULT_ORIGIN_COUNTRY =
  process.env.SHIPWISE_DEFAULT_ORIGIN_COUNTRY ?? "";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Set to true if Shipwise returns rates in CENTS instead of dollars.
const SHIPWISE_RETURNS_CENTS = false;

// Metafield namespace and keys for product dimensions.
const DIMENSION_METAFIELD_NAMESPACE = "shipping";
const DIMENSION_KEYS = {
  length: "length",
  width: "width",
  height: "height",
};

// Default dimensions if metafields are not set, in inches.
const DEFAULT_DIMENSIONS = {
  length: 12,
  width: 11,
  height: 11,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ShopifyAddress = {
  country?: string;
  country_code?: string;
  postal_code?: string;
  zip?: string;
  province?: string;
  province_code?: string;
  city?: string;
  name?: string | null;
  address1?: string;
  address2?: string;
  address3?: string | null;
  phone?: string | null;
  email?: string | null;
  company?: string | null;
  company_name?: string | null;
};

type ShopifyCartItem = {
  name?: string;
  sku?: string;
  quantity?: number;
  grams?: number;
  price?: number;
  requires_shipping?: boolean;
  product_id?: number;
  variant_id?: number;
  properties?: Record<string, unknown> | null;
  vendor?: string;
  fulfillment_service?: string;
};

type ShopifyRateRequest = {
  rate?: {
    origin?: ShopifyAddress;
    destination?: ShopifyAddress;
    items?: ShopifyCartItem[];
    currency?: string;
    locale?: string;
  };
};

type VariantShippingData = {
  length: number;
  width: number;
  height: number;
  weightLb: number | null;
  countryOfOrigin: string | null;
  provinceOfOrigin: string | null;
  harmonizedCode: string | null;
  countrySpecificHarmonizedCodes: Record<string, string>;
};

type ShipwiseAddress = {
  name: string;
  company: string;
  address1: string;
  address2: string;
  address3: string;
  city: string;
  state: string;
  postalCode: string;
  countryCode: string;
  phone: string;
  email: string;
};

// Internal item — includes fields needed for package building that are not
// sent in the Shipwise items array.
type ShipwiseItemInternal = {
  id: number;
  sku: string;
  marketProductKey: string;
  title: string;
  quantityToShip: number;
  quantityOrdered: number;
  unitPrice: number;
  unitCustoms: number;
  length: number;
  width: number;
  height: number;
  productId?: number;
  variantId?: number;
  countryOfOrigin: string;
  provinceOfOrigin: string;
  countryOfMfg: string;
  harmonizedCode: string;
  customsDescription: string;
  customsDeclaredValue: number;
  weightLb: number; // per-unit, used only for package/customs building
};

type ShipwiseRate = {
  carrierService?: string | null;
  carrierCode?: string | null;
  carrier?: string | null;
  class?: string | null;
  value?: number | null;
  currencyCodeIso?: string | null;
  transitTime?: {
    estimatedDeliveryDays?: number | null;
    estimatedDeliveryDate?: string | null;
  } | null;
  estimatedDeliveryDays?: number | null;
  estimatedDeliveryDate?: string | null;
};

type ShipwiseShipmentItem = {
  packageId?: string | null;
  selectedRate?: ShipwiseRate | null;
  rates?: ShipwiseRate[] | null;
};

type ShipwiseResponse = {
  wasSuccessful?: boolean;
  responseMsg?: string | null;
  shipmentItems?: ShipwiseShipmentItem[] | null;
  externalServices?: ShipwiseRate[] | null;
  rateErrors?: string[] | null;
  success?: boolean;
  customer?: string | null;
  profileId?: string | null;
  rates?: Array<Record<string, unknown>> | null;
};

type NormalizedShipwiseRate = {
  serviceName: string;
  serviceCode: string;
  value: number;
  currency: string | null;
  estimatedDeliveryDate?: string | null;
  estimatedDeliveryDays?: number | null;
};

type OperationalLogDetails = {
  correlationId: string;
  shopDomain: string | null;
  requestSuccess: boolean;
  responseStatus: number;
  latencyMs: number;
  itemCount: number;
  ratesCount: number;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

function createCorrelationId() {
  return `shipwise-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function logOperational(
  level: "info" | "warn" | "error",
  message: string,
  details: OperationalLogDetails,
) {
  if (level === "warn") {
    console.warn(message, details);
    return;
  }

  if (level === "error") {
    console.error(message, details);
    return;
  }

  console.log(message, details);
}

function logDebug(message: string, details: Record<string, unknown>) {
  if (!SHIPWISE_DEBUG_VERBOSE) return;
  console.log(message, details);
}

// ---------------------------------------------------------------------------
// Shopify token helper
// ---------------------------------------------------------------------------

async function getOfflineShopAdminAccessToken(
  shopDomain: string | null,
): Promise<string | null> {
  if (!shopDomain) return null;

  const offlineSession = await prisma.session.findFirst({
    where: {
      shop: shopDomain,
      isOnline: false,
    },
    select: {
      accessToken: true,
    },
  });

  return offlineSession?.accessToken ?? null;
}

// ---------------------------------------------------------------------------
// Weight helpers
// ---------------------------------------------------------------------------

function gramsToPoundsExact(grams: number) {
  if (!Number.isFinite(grams) || grams <= 0) return 0;
  return Number((grams / 453.59237).toFixed(6));
}

function shopifyWeightToPounds(
  weight: number | string | null | undefined,
  weightUnit: string | null | undefined,
): number | null {
  const weightNumber = typeof weight === "string" ? Number(weight) : weight;

  if (
    weightNumber == null ||
    !Number.isFinite(weightNumber) ||
    weightNumber <= 0
  ) {
    return null;
  }

  const unit = weightUnit?.toUpperCase();

  switch (unit) {
    case "POUNDS":
    case "POUND":
    case "LB":
    case "LBS":
      return Number(weightNumber.toFixed(6));

    case "OUNCES":
    case "OUNCE":
    case "OZ":
      return Number((weightNumber / 16).toFixed(6));

    case "KILOGRAMS":
    case "KILOGRAM":
    case "KG":
      return Number((weightNumber * 2.20462262185).toFixed(6));

    case "GRAMS":
    case "GRAM":
    case "G":
      return Number((weightNumber / 453.59237).toFixed(6));

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Country, region, and HS-code normalization helpers
// ---------------------------------------------------------------------------

const COUNTRY_NAME_MAP: Record<string, string> = {
  // North America
  "united states": "US",
  "united states of america": "US",
  usa: "US",
  canada: "CA",
  mexico: "MX",
  // Europe
  "united kingdom": "GB",
  "great britain": "GB",
  uk: "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  germany: "DE",
  france: "FR",
  italy: "IT",
  spain: "ES",
  netherlands: "NL",
  holland: "NL",
  belgium: "BE",
  switzerland: "CH",
  austria: "AT",
  sweden: "SE",
  norway: "NO",
  denmark: "DK",
  finland: "FI",
  portugal: "PT",
  ireland: "IE",
  poland: "PL",
  "czech republic": "CZ",
  czechia: "CZ",
  // Asia-Pacific
  australia: "AU",
  "new zealand": "NZ",
  japan: "JP",
  china: "CN",
  "south korea": "KR",
  korea: "KR",
  singapore: "SG",
  "hong kong": "HK",
  taiwan: "TW",
  india: "IN",
  // South America
  brazil: "BR",
  argentina: "AR",
  chile: "CL",
  colombia: "CO",
  // Middle East / Africa
  "united arab emirates": "AE",
  uae: "AE",
  israel: "IL",
  "south africa": "ZA",
};

function normalizeCountryCode(country: string | null | undefined): string {
  if (!country) return "";

  const value = country.trim();
  if (!value) return "";

  // Any 2-letter input is already ISO-2 — just uppercase it.
  if (/^[A-Za-z]{2}$/.test(value)) {
    return value.toUpperCase();
  }

  const mapped = COUNTRY_NAME_MAP[value.toLowerCase()];
  if (mapped) return mapped;

  console.warn("[Shipwise] Country not recognized as ISO-2 or known name", {
    country,
  });

  return "";
}

function normalizeRegionCode(
  region: string | null | undefined,
  countryCode: string,
): string {
  if (!region) return "";

  const value = region.trim();
  if (!value) return "";

  const lower = value.toLowerCase();

  if (countryCode === "CA") {
    const canadaMap: Record<string, string> = {
      alberta: "AB",
      "british columbia": "BC",
      manitoba: "MB",
      "new brunswick": "NB",
      "newfoundland and labrador": "NL",
      "northwest territories": "NT",
      "nova scotia": "NS",
      nunavut: "NU",
      ontario: "ON",
      "prince edward island": "PE",
      quebec: "QC",
      saskatchewan: "SK",
      yukon: "YT",
    };

    const mapped = canadaMap[lower];
    if (mapped) return mapped;
  }

  // Most Shopify carrier-service requests already send province/state as a code.
  if (/^[A-Za-z0-9-]{2,3}$/.test(value)) {
    return value.toUpperCase();
  }

  console.warn("[Shipwise] Region was not a short province/state code", {
    countryCode,
    region,
  });

  return "";
}

function normalizeHarmonizedCode(code: string | null | undefined): string {
  if (!code) return "";

  const value = code.trim().replace(/[.\s-]/g, "");

  if (!value) return "";

  if (/^\d{6,13}$/.test(value)) {
    return value;
  }

  console.warn("[Shipwise] Invalid HS code format", {
    code,
  });

  return "";
}

// ---------------------------------------------------------------------------
// Debug summary helpers
// ---------------------------------------------------------------------------

function summarizeIncomingRequest(
  rate: ShopifyRateRequest["rate"],
  itemCount: number,
) {
  return {
    hasOrigin: Boolean(rate?.origin),
    hasDestination: Boolean(rate?.destination),
    originCountry: rate?.origin?.country_code ?? rate?.origin?.country ?? null,
    destinationCountry:
      rate?.destination?.country_code ?? rate?.destination?.country ?? null,
    currency: rate?.currency ?? "USD",
    itemCount,
  };
}

function summarizePreparedItems(
  items: ShipwiseItemInternal[],
  shippingDataMap: Map<number, VariantShippingData>,
) {
  return items.map((item) => {
    const variantData =
      typeof item.variantId === "number"
        ? shippingDataMap.get(item.variantId)
        : undefined;

    return {
      quantity: item.quantityToShip,
      weightLb: Number(item.weightLb.toFixed(6)),
      dimensions: `${item.length}x${item.width}x${item.height}`,
      weightSource:
        variantData?.weightLb != null && variantData.weightLb > 0
          ? "variant_weight"
          : "callback_grams_fallback",
      hasVariantId: typeof item.variantId === "number",
      countryOfOrigin: item.countryOfOrigin || null,
      hasHarmonizedCode: Boolean(item.harmonizedCode),
    };
  });
}

// ---------------------------------------------------------------------------
// Fetch variant dimensions, weight, origin, and HS code from Shopify Admin
// ---------------------------------------------------------------------------

async function fetchVariantShippingData(
  variantIds: number[],
  correlationId: string,
  requestedShopDomain: string | null,
  adminAccessToken: string | null,
): Promise<Map<number, VariantShippingData>> {
  const shippingDataMap = new Map<number, VariantShippingData>();
  const adminStoreDomain = requestedShopDomain;

  if (!adminStoreDomain || !adminAccessToken) {
    logDebug("[Shipwise] Variant lookup skipped", {
      correlationId,
      shopDomain: requestedShopDomain,
      hasAdminToken: Boolean(adminAccessToken),
      requestedVariantCount: variantIds.length,
    });
    return shippingDataMap;
  }

  const uniqueVariantIds = [...new Set(variantIds)];
  if (!uniqueVariantIds.length) {
    return shippingDataMap;
  }

  const variantGids = uniqueVariantIds.map(
    (id) => `gid://shopify/ProductVariant/${id}`,
  );

  const query = `
    query GetVariantShippingData($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          legacyResourceId
          inventoryItem {
            measurement {
              weight {
                value
                unit
              }
            }
            countryCodeOfOrigin
            provinceCodeOfOrigin
            harmonizedSystemCode
            countryHarmonizedSystemCodes(first: 20) {
              nodes {
                countryCode
                harmonizedSystemCode
              }
            }
          }
          metafield_length: metafield(namespace: "${DIMENSION_METAFIELD_NAMESPACE}", key: "${DIMENSION_KEYS.length}") { value }
          metafield_width: metafield(namespace: "${DIMENSION_METAFIELD_NAMESPACE}", key: "${DIMENSION_KEYS.width}") { value }
          metafield_height: metafield(namespace: "${DIMENSION_METAFIELD_NAMESPACE}", key: "${DIMENSION_KEYS.height}") { value }
        }
      }
    }
  `;

  try {
    const response = await fetch(
      `https://${adminStoreDomain}/admin/api/${apiVersion}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": adminAccessToken,
        },
        body: JSON.stringify({
          query,
          variables: { ids: variantGids },
        }),
      },
    );

    if (!response.ok) {
      logDebug("[Shipwise] Variant lookup HTTP failure", {
        correlationId,
        shopDomain: requestedShopDomain,
        requestedVariantCount: uniqueVariantIds.length,
        responseStatus: response.status,
      });
      return shippingDataMap;
    }

    const data = (await response.json()) as {
      data?: {
        nodes?: Array<{
          legacyResourceId?: string;
          inventoryItem?: {
            measurement?: {
              weight?: {
                value?: number | string | null;
                unit?: string | null;
              } | null;
            } | null;
            countryCodeOfOrigin?: string | null;
            provinceCodeOfOrigin?: string | null;
            harmonizedSystemCode?: string | null;
            countryHarmonizedSystemCodes?: {
              nodes?: Array<{
                countryCode?: string | null;
                harmonizedSystemCode?: string | null;
              } | null>;
            } | null;
          } | null;
          metafield_length?: { value?: string | null } | null;
          metafield_width?: { value?: string | null } | null;
          metafield_height?: { value?: string | null } | null;
        } | null>;
      };
      errors?: unknown;
    };

    if (data.errors) {
      logDebug("[Shipwise] Variant lookup GraphQL errors", {
        correlationId,
        shopDomain: requestedShopDomain,
        requestedVariantCount: uniqueVariantIds.length,
        errors: data.errors,
      });
      return shippingDataMap;
    }

    for (const node of data.data?.nodes ?? []) {
      if (!node?.legacyResourceId) continue;

      const variantId = Number.parseInt(node.legacyResourceId, 10);
      if (!Number.isFinite(variantId)) continue;

      const length =
        Number.parseFloat(node.metafield_length?.value ?? "") ||
        DEFAULT_DIMENSIONS.length;
      const width =
        Number.parseFloat(node.metafield_width?.value ?? "") ||
        DEFAULT_DIMENSIONS.width;
      const height =
        Number.parseFloat(node.metafield_height?.value ?? "") ||
        DEFAULT_DIMENSIONS.height;

      const weightValue = node.inventoryItem?.measurement?.weight?.value;
      const weightUnit = node.inventoryItem?.measurement?.weight?.unit;
      const weightLb = shopifyWeightToPounds(weightValue, weightUnit);

      const countryOfOrigin = normalizeCountryCode(
        node.inventoryItem?.countryCodeOfOrigin,
      );

      const provinceOfOrigin = normalizeRegionCode(
        node.inventoryItem?.provinceCodeOfOrigin,
        countryOfOrigin,
      );

      const harmonizedCode = normalizeHarmonizedCode(
        node.inventoryItem?.harmonizedSystemCode,
      );

      const countrySpecificHarmonizedCodes: Record<string, string> = {};

      for (const countryCodeNode of
        node.inventoryItem?.countryHarmonizedSystemCodes?.nodes ?? []) {
        const countryCode = normalizeCountryCode(countryCodeNode?.countryCode);
        const countryHsCode = normalizeHarmonizedCode(
          countryCodeNode?.harmonizedSystemCode,
        );

        if (countryCode && countryHsCode) {
          countrySpecificHarmonizedCodes[countryCode] = countryHsCode;
        }
      }

      shippingDataMap.set(variantId, {
        length,
        width,
        height,
        weightLb,
        countryOfOrigin: countryOfOrigin || null,
        provinceOfOrigin: provinceOfOrigin || null,
        harmonizedCode: harmonizedCode || null,
        countrySpecificHarmonizedCodes,
      });
    }

    logDebug("[Shipwise] Variant lookup summary", {
      correlationId,
      shopDomain: requestedShopDomain,
      requestedVariantCount: uniqueVariantIds.length,
      returnedVariantCount: shippingDataMap.size,
    });
  } catch (error) {
    logDebug("[Shipwise] Variant lookup request failed", {
      correlationId,
      shopDomain: requestedShopDomain,
      requestedVariantCount: uniqueVariantIds.length,
      error: error instanceof Error ? error.name : "variant_lookup_failed",
    });
  }

  return shippingDataMap;
}

// ---------------------------------------------------------------------------
// Convert Shopify address to Shipwise address format
// ---------------------------------------------------------------------------

function convertAddress(
  addr: ShopifyAddress | undefined,
  fallbackName: string,
): ShipwiseAddress {
  const countryCode = normalizeCountryCode(addr?.country_code ?? addr?.country);
  const state = normalizeRegionCode(
    addr?.province_code ?? addr?.province,
    countryCode,
  );

  return {
    name: addr?.name ?? fallbackName,
    company: addr?.company ?? addr?.company_name ?? "",
    address1: addr?.address1 ?? "",
    address2: addr?.address2 ?? "",
    address3: addr?.address3 ?? "",
    city: addr?.city ?? "",
    state,
    postalCode: addr?.postal_code ?? addr?.zip ?? "",
    countryCode,
    phone: addr?.phone ?? "",
    email: addr?.email ?? "",
  };
}

// ---------------------------------------------------------------------------
// Rate normalization helpers
// ---------------------------------------------------------------------------

function extractNumericValue(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function appendNormalizedRate(
  allRates: NormalizedShipwiseRate[],
  rate: ShipwiseRate | null | undefined,
  fallbackCurrency: string,
  fallbackServiceCode: string,
) {
  if (!rate || rate.value == null || rate.value <= 0) return;

  const valueInDollars = SHIPWISE_RETURNS_CENTS ? rate.value / 100 : rate.value;

  const serviceName =
    rate.carrierService ??
    rate.class ??
    rate.carrier ??
    rate.carrierCode ??
    "Shipping";

  // Stable service_code: prefer carrierService slug, then carrierCode, then class.
  const serviceCode = rate.carrierService
    ? slugify(rate.carrierService)
    : rate.carrierCode
      ? slugify(rate.carrierCode)
      : rate.class
        ? slugify(rate.class)
        : fallbackServiceCode;

  allRates.push({
    serviceName,
    serviceCode,
    value: valueInDollars,
    currency: rate.currencyCodeIso ?? fallbackCurrency,
    estimatedDeliveryDate:
      rate.estimatedDeliveryDate ??
      rate.transitTime?.estimatedDeliveryDate ??
      null,
    estimatedDeliveryDays:
      rate.estimatedDeliveryDays ??
      rate.transitTime?.estimatedDeliveryDays ??
      null,
  });
}

// ---------------------------------------------------------------------------
// Main action: called by Shopify during checkout
// ---------------------------------------------------------------------------

export const action = async ({ request }: ActionFunctionArgs) => {
  const correlationId = createCorrelationId();
  const startedAt = Date.now();

  if (request.method !== "POST") {
    logOperational("warn", "[Shipwise] Rejected non-POST request", {
      correlationId,
      shopDomain: null,
      requestSuccess: false,
      responseStatus: 405,
      latencyMs: Date.now() - startedAt,
      itemCount: 0,
      ratesCount: 0,
    });

    return json({ error: "Method Not Allowed", correlationId }, { status: 405 });
  }

  const shopDomain =
    request.headers.get("x-shopify-shop-domain") ??
    request.headers.get("X-Shopify-Shop-Domain") ??
    null;

  const config = shopDomain
    ? await prisma.shipwiseConfig.findUnique({ where: { shop: shopDomain } })
    : null;

  const shipwiseBearerToken = config?.bearerToken ?? null;

  // CHANGE 10: Fail loudly in logs when any required config is missing.
  if (!SHIPWISE_API_URL || !shipwiseBearerToken) {
    const missingConfig = !SHIPWISE_API_URL
      ? "SHIPWISE_API_URL not set"
      : "no Shipwise bearer token for shop";

    logOperational(
      "warn",
      `[Shipwise] Misconfiguration — returning empty rates: ${missingConfig}`,
      {
        correlationId,
        shopDomain,
        requestSuccess: false,
        responseStatus: 200,
        latencyMs: Date.now() - startedAt,
        itemCount: 0,
        ratesCount: 0,
        missingConfig,
      },
    );

    return json({ rates: [] }, { status: 200 });
  }

  let shopifyBody: ShopifyRateRequest;

  try {
    shopifyBody = (await request.json()) as ShopifyRateRequest;
  } catch {
    logOperational("warn", "[Shipwise] Invalid Shopify payload", {
      correlationId,
      shopDomain,
      requestSuccess: false,
      responseStatus: 400,
      latencyMs: Date.now() - startedAt,
      itemCount: 0,
      ratesCount: 0,
    });

    return json({ rates: [] }, { status: 400 });
  }

  const rate = shopifyBody.rate;

  if (!rate) {
    logOperational("warn", "[Shipwise] Missing rate object", {
      correlationId,
      shopDomain,
      requestSuccess: false,
      responseStatus: 400,
      latencyMs: Date.now() - startedAt,
      itemCount: 0,
      ratesCount: 0,
    });

    return json({ rates: [] }, { status: 400 });
  }

  const items = rate.items ?? [];
  const shippableItems = items.filter(
    (item) => item.requires_shipping !== false,
  );

  logDebug("[Shipwise] Redacted incoming request summary", {
    correlationId,
    shopDomain,
    ...summarizeIncomingRequest(rate, shippableItems.length),
  });

  if (!shippableItems.length) {
    logOperational("info", "[Shipwise] No shippable items", {
      correlationId,
      shopDomain,
      requestSuccess: true,
      responseStatus: 200,
      latencyMs: Date.now() - startedAt,
      itemCount: 0,
      ratesCount: 0,
    });

    return json({ rates: [] }, { status: 200 });
  }

  const shopCurrency = rate.currency ?? "USD";
  const shipwiseOrigin = convertAddress(rate.origin, "Origin");
  const shipwiseDestination = convertAddress(rate.destination, "Destination");

  // CHANGE 5: Fail if destination country normalization yields a blank code.
  if (!shipwiseDestination.countryCode) {
    const rawDestinationCountry =
      rate.destination?.country_code ?? rate.destination?.country ?? null;

    logOperational(
      "warn",
      "[Shipwise] Destination country normalization failed — returning empty rates",
      {
        correlationId,
        shopDomain,
        requestSuccess: false,
        responseStatus: 200,
        latencyMs: Date.now() - startedAt,
        itemCount: shippableItems.length,
        ratesCount: 0,
        rawDestinationCountry,
      },
    );

    return json({ rates: [] }, { status: 200 });
  }

  const isInternational =
    Boolean(shipwiseOrigin.countryCode) &&
    Boolean(shipwiseDestination.countryCode) &&
    shipwiseOrigin.countryCode !== shipwiseDestination.countryCode;

  logDebug("[Shipwise] Normalized address summary", {
    correlationId,
    shopDomain,
    isInternational,
    origin: {
      city: shipwiseOrigin.city,
      state: shipwiseOrigin.state,
      postalCode: shipwiseOrigin.postalCode,
      countryCode: shipwiseOrigin.countryCode,
    },
    destination: {
      city: shipwiseDestination.city,
      state: shipwiseDestination.state,
      postalCode: shipwiseDestination.postalCode,
      countryCode: shipwiseDestination.countryCode,
    },
  });

  const variantIds = shippableItems
    .filter((item) => typeof item.variant_id === "number")
    .map((item) => item.variant_id as number);

  const shopifyAdminAccessToken =
    await getOfflineShopAdminAccessToken(shopDomain);

  // CHANGE 9: Log when admin token is missing (non-fatal, but variant data unavailable).
  if (!shopifyAdminAccessToken) {
    console.warn("[Shipwise] Admin token missing for shop — variant data unavailable", {
      correlationId,
      shopDomain,
    });
  }

  const shippingDataMap = await fetchVariantShippingData(
    variantIds,
    correlationId,
    shopDomain,
    shopifyAdminAccessToken,
  );

  const shipwiseItems: ShipwiseItemInternal[] = shippableItems.map(
    (item, index) => {
      const quantity = item.quantity ?? 1;
      const grams = item.grams ?? 0;

      const variantData =
        typeof item.variant_id === "number"
          ? shippingDataMap.get(item.variant_id)
          : undefined;

      const hasVariantWeight =
        typeof variantData?.weightLb === "number" &&
        Number.isFinite(variantData.weightLb) &&
        variantData.weightLb > 0;

      const weightLb = hasVariantWeight
        ? (variantData?.weightLb as number)
        : gramsToPoundsExact(grams);

      const unitPrice = Number(((item.price ?? 0) / 100).toFixed(2));
      const sku = item.sku ?? item.name ?? `item-${index + 1}`;
      const title = item.name ?? item.sku ?? "Item";
      const destinationCountryCode = shipwiseDestination.countryCode;

      const countryOfOrigin =
        variantData?.countryOfOrigin ?? shipwiseOrigin.countryCode ?? "";

      const provinceOfOrigin = variantData?.provinceOfOrigin ?? "";

      // CHANGE 6: countryOfMfg fallback chain.
      const countryOfMfg =
        variantData?.countryOfOrigin ||
        shipwiseOrigin.countryCode ||
        SHIPWISE_DEFAULT_ORIGIN_COUNTRY ||
        "US";

      const harmonizedCode =
        normalizeHarmonizedCode(
          destinationCountryCode
            ? variantData?.countrySpecificHarmonizedCodes?.[
                destinationCountryCode
              ]
            : undefined,
        ) ||
        normalizeHarmonizedCode(variantData?.harmonizedCode) ||
        normalizeHarmonizedCode(SHIPWISE_DEFAULT_HS_CODE);

      const marketProductKey =
        item.variant_id?.toString() ??
        item.product_id?.toString() ??
        sku;

      // CHANGE 9: Operational log for missing international data after fallbacks.
      if (isInternational && !countryOfOrigin) {
        console.warn(
          "[Shipwise] International item missing country of origin after fallbacks",
          { correlationId, itemIndex: index, hasVariantId: typeof item.variant_id === "number" },
        );
      }

      if (isInternational && !harmonizedCode) {
        console.warn(
          "[Shipwise] International item missing HS code after fallbacks",
          { correlationId, itemIndex: index, hasVariantId: typeof item.variant_id === "number" },
        );
      }

      return {
        id: index + 1,
        sku,
        marketProductKey,
        title,
        quantityToShip: quantity,
        quantityOrdered: quantity,
        unitPrice,
        unitCustoms: unitPrice,
        length: variantData?.length ?? DEFAULT_DIMENSIONS.length,
        width: variantData?.width ?? DEFAULT_DIMENSIONS.width,
        height: variantData?.height ?? DEFAULT_DIMENSIONS.height,
        productId: item.product_id,
        variantId: item.variant_id,
        countryOfOrigin,
        provinceOfOrigin,
        countryOfMfg,
        harmonizedCode,
        customsDescription: title,
        customsDeclaredValue: unitPrice,
        weightLb,
      };
    },
  );

  logDebug("[Shipwise] Prepared redacted request summary", {
    correlationId,
    shopDomain,
    isInternational,
    itemCount: shipwiseItems.length,
    items: summarizePreparedItems(shipwiseItems, shippingDataMap),
  });

  const consolidatedWeightLb = shipwiseItems.reduce(
    (sum, item) => sum + item.weightLb * item.quantityToShip,
    0,
  );
  const consolidatedLength = Math.max(...shipwiseItems.map((i) => i.length));
  const consolidatedWidth = Math.max(...shipwiseItems.map((i) => i.width));
  const consolidatedHeight = Math.max(...shipwiseItems.map((i) => i.height));
  const consolidatedValue = shipwiseItems.reduce(
    (sum, item) => sum + item.unitPrice * item.quantityToShip,
    0,
  );
  const primaryItem = shipwiseItems[0];

  const shipwiseRequestBody = {
    items: [
      {
        sku: primaryItem.sku,
        description: primaryItem.customsDescription,
        quantity: 1,
        weight: consolidatedWeightLb,
        length: consolidatedLength,
        width: consolidatedWidth,
        height: consolidatedHeight,
        value: consolidatedValue,
        countryOfOrigin: primaryItem.countryOfOrigin,
        harmonizedCode: primaryItem.harmonizedCode,
        customsDescription: primaryItem.customsDescription,
      },
    ],
    destination: {
      name: shipwiseDestination.name,
      company: shipwiseDestination.company,
      address1: shipwiseDestination.address1,
      address2: shipwiseDestination.address2,
      city: shipwiseDestination.city,
      state: shipwiseDestination.state,
      zip: shipwiseDestination.postalCode,
      country: shipwiseDestination.countryCode,
      phone: shipwiseDestination.phone,
      email: shipwiseDestination.email,
    },
  };

  const shipwiseUrl = `${SHIPWISE_API_URL.replace(/\/$/, "")}/api/shipping-rates`;

  const controller = new AbortController();
  // CHANGE 8: 6 s timeout (Shopify budget is ~10 s; leave headroom for parsing).
  const timeoutId = setTimeout(() => controller.abort(), 6000);

  let shipwiseRes: Response;

  try {
    shipwiseRes = await fetch(shipwiseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${shipwiseBearerToken}`,
        "X-Correlation-ID": correlationId,
      },
      body: JSON.stringify(shipwiseRequestBody),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeoutId);

    logOperational("error", "[Shipwise] Shipwise request failed", {
      correlationId,
      shopDomain,
      requestSuccess: false,
      responseStatus: 502,
      latencyMs: Date.now() - startedAt,
      itemCount: shippableItems.length,
      ratesCount: 0,
    });

    logDebug("[Shipwise] Request failure summary", {
      correlationId,
      shopDomain,
      error: error instanceof Error ? error.name : "shipwise_request_failed",
    });

    return json({ rates: [] }, { status: 502 });
  }

  clearTimeout(timeoutId);

  let shipwiseJson: ShipwiseResponse;

  try {
    shipwiseJson = (await shipwiseRes.json()) as ShipwiseResponse;
  } catch {
    logOperational("error", "[Shipwise] Invalid Shipwise JSON response", {
      correlationId,
      shopDomain,
      requestSuccess: false,
      responseStatus: shipwiseRes.status,
      latencyMs: Date.now() - startedAt,
      itemCount: shippableItems.length,
      ratesCount: 0,
    });

    return json({ rates: [] }, { status: 502 });
  }

  logDebug("[Shipwise] Shipwise response summary", {
    correlationId,
    shopDomain,
    responseStatus: shipwiseRes.status,
    wasSuccessful: shipwiseJson.wasSuccessful ?? null,
    success: shipwiseJson.success ?? null,
    shipmentItemsCount: shipwiseJson.shipmentItems?.length ?? 0,
    externalServicesCount: shipwiseJson.externalServices?.length ?? 0,
    topLevelRatesCount: Array.isArray(shipwiseJson.rates)
      ? shipwiseJson.rates.length
      : 0,
    rateErrorsCount: shipwiseJson.rateErrors?.length ?? 0,
    responseMsg: shipwiseJson.responseMsg ?? null,
  });

  if (
    !shipwiseRes.ok ||
    shipwiseJson.wasSuccessful === false ||
    shipwiseJson.success === false
  ) {
    logOperational("error", "[Shipwise] Shipwise returned error status", {
      correlationId,
      shopDomain,
      requestSuccess: false,
      responseStatus: shipwiseRes.status,
      latencyMs: Date.now() - startedAt,
      itemCount: shippableItems.length,
      ratesCount: 0,
    });

    return json({ rates: [] }, { status: 502 });
  }

  const allRates: NormalizedShipwiseRate[] = [];

  for (const shipmentItem of shipwiseJson.shipmentItems ?? []) {
    appendNormalizedRate(
      allRates,
      shipmentItem.selectedRate,
      shopCurrency,
      "standard",
    );

    for (const shipmentRate of shipmentItem.rates ?? []) {
      appendNormalizedRate(allRates, shipmentRate, shopCurrency, "standard");
    }
  }

  for (const externalRate of shipwiseJson.externalServices ?? []) {
    appendNormalizedRate(allRates, externalRate, shopCurrency, "external");
  }

  if (Array.isArray(shipwiseJson.rates)) {
    for (const rawRate of shipwiseJson.rates) {
      const record = rawRate as Record<string, unknown>;

      const numericValue = extractNumericValue(
        record.value ??
          record.total ??
          record.amount ??
          record.price ??
          record.rate,
      );

      if (numericValue == null || numericValue <= 0) continue;

      const valueInDollars = SHIPWISE_RETURNS_CENTS
        ? numericValue / 100
        : numericValue;

      const currency =
        (record.currencyCodeIso as string | undefined) ??
        (record.currency as string | undefined) ??
        (record.currency_code as string | undefined) ??
        shopCurrency;

      const serviceName =
        (record.serviceName as string | undefined) ??
        (record.service as string | undefined) ??
        (record.carrierService as string | undefined) ??
        (record.class as string | undefined) ??
        (record.carrier as string | undefined) ??
        (record.carrierCode as string | undefined) ??
        "Shipping";

      const rawServiceCode =
        (record.serviceCode as string | undefined) ??
        (record.carrierService as string | undefined) ??
        (record.carrierCode as string | undefined) ??
        (record.class as string | undefined);

      const serviceCode = rawServiceCode ? slugify(rawServiceCode) : "standard";

      const estimatedDeliveryDays =
        (record.estimatedDeliveryDays as number | null | undefined) ??
        (record.transitDays as number | null | undefined) ??
        (record.transit_time as number | null | undefined) ??
        (
          record.transitTime as
            | { estimatedDeliveryDays?: number | null }
            | undefined
        )?.estimatedDeliveryDays ??
        null;

      const estimatedDeliveryDate =
        (record.estimatedDeliveryDate as string | null | undefined) ??
        (
          record.transitTime as
            | { estimatedDeliveryDate?: string | null }
            | undefined
        )?.estimatedDeliveryDate ??
        null;

      allRates.push({
        serviceName,
        serviceCode,
        value: valueInDollars,
        currency,
        estimatedDeliveryDate,
        estimatedDeliveryDays,
      });
    }
  }

  if (!allRates.length) {
    logOperational("info", "[Shipwise] No usable rates returned", {
      correlationId,
      shopDomain,
      requestSuccess: true,
      responseStatus: 200,
      latencyMs: Date.now() - startedAt,
      itemCount: shippableItems.length,
      ratesCount: 0,
    });

    return json({ rates: [] }, { status: 200 });
  }

  const lowestRate = allRates.reduce((min, r) => (r.value < min.value ? r : min));
  const totalPriceCents = Math.round(lowestRate.value * 100);

  const shopifyRate = {
    service_name: "Shipping",
    service_code: "shipping",
    description: "",
    total_price: totalPriceCents.toString(),
    currency: lowestRate.currency ?? shopCurrency,
  };

  logOperational("info", "[Shipwise] Returning rates to Shopify", {
    correlationId,
    shopDomain,
    requestSuccess: true,
    responseStatus: 200,
    latencyMs: Date.now() - startedAt,
    itemCount: shippableItems.length,
    ratesCount: 1,
  });

  return json({ rates: [shopifyRate] }, { status: 200 });
};
