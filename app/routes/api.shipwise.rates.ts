import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import { apiVersion } from "../shopify.server";

// ---------------------------------------------------------------------------
// Tiny local json() helper (since react-router doesn't export one here)
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

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Set to true if Shipwise returns rates in CENTS instead of dollars
const SHIPWISE_RETURNS_CENTS = false;

// Metafield namespace and keys for product dimensions
const DIMENSION_METAFIELD_NAMESPACE = "shipping";
const DIMENSION_KEYS = {
  length: "length",
  width: "width",
  height: "height",
};

// Default dimensions if metafields are not set (fallback)
const DEFAULT_DIMENSIONS = {
  length: 10,
  width: 8,
  height: 4,
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
  price?: number; // cents
  requires_shipping?: boolean;
  product_id?: number;
  variant_id?: number;
  properties?: Record<string, string> | null;
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
  rates?: Array<Record<string, unknown>> | ShipwiseRate[] | null;
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
// Helper: offline token lookup for Shopify Admin
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
// Helper: Exact grams -> pounds fallback conversion
// ---------------------------------------------------------------------------

function gramsToPoundsExact(grams: number) {
  if (!Number.isFinite(grams) || grams <= 0) return 0;
  return Number((grams / 453.59237).toFixed(6));
}

// ---------------------------------------------------------------------------
// Helper: Convert Shopify's stored variant weight/unit into pounds
// ---------------------------------------------------------------------------

function shopifyWeightToPounds(
  weight: number | null | undefined,
  weightUnit: string | null | undefined,
): number | null {
  if (weight == null || !Number.isFinite(weight) || weight <= 0) return null;

  switch (weightUnit) {
    case "POUNDS":
      return Number(weight.toFixed(6));
    case "OUNCES":
      return Number((weight / 16).toFixed(6));
    case "KILOGRAMS":
      return Number((weight * 2.20462262185).toFixed(6));
    case "GRAMS":
      return Number((weight / 453.59237).toFixed(6));
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Debug-only redacted summaries
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
  items: Array<{
    quantity: number;
    weight: number;
    length: number;
    width: number;
    height: number;
    variantId?: number;
  }>,
  shippingDataMap: Map<number, VariantShippingData>,
) {
  return items.map((item) => {
    const variantData =
      typeof item.variantId === "number"
        ? shippingDataMap.get(item.variantId)
        : undefined;

    return {
      quantity: item.quantity,
      weightLb: Number(item.weight.toFixed(6)),
      dimensions: `${item.length}x${item.width}x${item.height}`,
      weightSource:
        variantData?.weightLb != null && variantData.weightLb > 0
          ? "variant_weight"
          : "callback_grams_fallback",
      hasVariantId: typeof item.variantId === "number",
    };
  });
}

// ---------------------------------------------------------------------------
// Helper: Fetch variant dimensions + exact variant weight from Shopify Admin
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
          weight
          weightUnit
          metafield_length: metafield(namespace: "${DIMENSION_METAFIELD_NAMESPACE}", key: "${DIMENSION_KEYS.length}") {
            value
          }
          metafield_width: metafield(namespace: "${DIMENSION_METAFIELD_NAMESPACE}", key: "${DIMENSION_KEYS.width}") {
            value
          }
          metafield_height: metafield(namespace: "${DIMENSION_METAFIELD_NAMESPACE}", key: "${DIMENSION_KEYS.height}") {
            value
          }
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
          weight?: number | null;
          weightUnit?: string | null;
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
      const weightLb = shopifyWeightToPounds(node.weight, node.weightUnit);

      shippingDataMap.set(variantId, {
        length,
        width,
        height,
        weightLb,
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
// Helper: Convert Shopify address to Shipwise format
// ---------------------------------------------------------------------------

function convertAddress(addr: ShopifyAddress | undefined, fallbackName: string) {
  if (!addr) {
    return {
      name: fallbackName,
      company: "",
      address1: "",
      address2: "",
      address3: "",
      city: "",
      state: "",
      postalCode: "",
      countryCode: "",
      phone: "",
      email: "",
    };
  }

  return {
    name: addr.name ?? fallbackName,
    company: addr.company ?? addr.company_name ?? "",
    address1: addr.address1 ?? "",
    address2: addr.address2 ?? "",
    address3: addr.address3 ?? "",
    city: addr.city ?? "",
    state: addr.province ?? addr.province_code ?? "",
    postalCode: addr.postal_code ?? addr.zip ?? "",
    countryCode: addr.country_code ?? addr.country ?? "",
    phone: addr.phone ?? "",
    email: addr.email ?? "",
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

function appendNormalizedRate(
  allRates: NormalizedShipwiseRate[],
  rate: ShipwiseRate | null | undefined,
  fallbackCurrency: string,
  fallbackServiceCode: string,
) {
  if (!rate || rate.value == null || rate.value <= 0) return;

  const valueInDollars = SHIPWISE_RETURNS_CENTS ? rate.value / 100 : rate.value;

  allRates.push({
    serviceName:
      rate.carrierService ??
      rate.class ??
      rate.carrier ??
      rate.carrierCode ??
      "Shipping",
    serviceCode:
      rate.carrierService ??
      rate.carrierCode ??
      rate.class ??
      fallbackServiceCode,
    value: valueInDollars,
    currency: rate.currencyCodeIso ?? fallbackCurrency,
    estimatedDeliveryDate:
      rate.estimatedDeliveryDate ?? rate.transitTime?.estimatedDeliveryDate ?? null,
    estimatedDeliveryDays:
      rate.estimatedDeliveryDays ?? rate.transitTime?.estimatedDeliveryDays ?? null,
  });
}

// ---------------------------------------------------------------------------
// Main action – called by Shopify during checkout
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

  if (!shipwiseBearerToken) {
    logOperational("warn", "[Shipwise] No Shipwise token configured", {
      correlationId,
      shopDomain,
      requestSuccess: false,
      responseStatus: 200,
      latencyMs: Date.now() - startedAt,
      itemCount: 0,
      ratesCount: 0,
    });

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
  const shippableItems = items.filter((item) => item.requires_shipping !== false);

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

  const variantIds = shippableItems
    .filter((item) => typeof item.variant_id === "number")
    .map((item) => item.variant_id as number);

  const shopifyAdminAccessToken = await getOfflineShopAdminAccessToken(shopDomain);

  const shippingDataMap = await fetchVariantShippingData(
    variantIds,
    correlationId,
    shopDomain,
    shopifyAdminAccessToken,
  );

  const shipwiseItems = shippableItems.map((item, index) => {
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

    const weightPerItemLb = hasVariantWeight
      ? (variantData?.weightLb as number)
      : gramsToPoundsExact(grams);

    return {
      id: index + 1,
      sku: item.sku ?? item.name ?? `item-${index + 1}`,
      description: item.name ?? item.sku ?? "Item",
      quantity,
      weight: weightPerItemLb,
      length: variantData?.length ?? DEFAULT_DIMENSIONS.length,
      width: variantData?.width ?? DEFAULT_DIMENSIONS.width,
      height: variantData?.height ?? DEFAULT_DIMENSIONS.height,
      price: (item.price ?? 0) / 100,
      productId: item.product_id,
      variantId: item.variant_id,
    };
  });

  logDebug("[Shipwise] Prepared redacted request summary", {
    correlationId,
    shopDomain,
    itemCount: shipwiseItems.length,
    items: summarizePreparedItems(shipwiseItems, shippingDataMap),
  });

  const shipwiseOrigin = convertAddress(rate.origin, "Origin");
  const shipwiseDestination = convertAddress(rate.destination, "Destination");

  const shipwiseRequestBody = {
    items: shipwiseItems,
    origin: shipwiseOrigin,
    destination: shipwiseDestination,
    currency: shopCurrency,
  };

  const shipwiseUrl = `${SHIPWISE_API_URL.replace(/\/$/, "")}/api/shipping-rates`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

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
    appendNormalizedRate(allRates, shipmentItem.selectedRate, shopCurrency, "standard");

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

      const serviceCode =
        (record.serviceCode as string | undefined) ??
        (record.carrierService as string | undefined) ??
        (record.carrierCode as string | undefined) ??
        (record.class as string | undefined) ??
        "standard";

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

  const lowestRate = allRates.reduce((min, current) =>
    current.value < min.value ? current : min,
  );

  const totalPriceCents = Math.round(lowestRate.value * 100);

  const shopifyRate = {
    service_name: lowestRate.serviceName,
    service_code: lowestRate.serviceCode,
    total_price: totalPriceCents.toString(),
    currency: lowestRate.currency ?? shopCurrency,
    ...(lowestRate.estimatedDeliveryDate
      ? {
          min_delivery_date: lowestRate.estimatedDeliveryDate,
          max_delivery_date: lowestRate.estimatedDeliveryDate,
        }
      : {}),
  };

  logOperational("info", "[Shipwise] Returning rate to Shopify", {
    correlationId,
    shopDomain,
    requestSuccess: true,
    responseStatus: 200,
    latencyMs: Date.now() - startedAt,
    itemCount: shippableItems.length,
    ratesCount: allRates.length,
  });

  return json({ rates: [shopifyRate] }, { status: 200 });
};
