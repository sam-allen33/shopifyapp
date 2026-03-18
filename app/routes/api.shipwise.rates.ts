import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";

function json(data: unknown, init?: number | ResponseInit): Response {
  const body = JSON.stringify(data);

  if (typeof init === "number") {
    return new Response(body, {
      status: init,
      headers: { "Content-Type": "application/json" },
  }

  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return new Response(body, {
    ...init,
    headers,
}

privacy-fix-v2
const SHIPWISE_API_URL = process.env.SHIPWISE_API_URL ?? "https://api.shipwise.com";
const SHIPWISE_DEBUG_VERBOSE =
  (process.env.SHIPWISE_DEBUG_VERBOSE ?? "false").toLowerCase() === "true";

// ---------------------------------------------------------------------------
// Environment configuration
// ---------------------------------------------------------------------------

const SHIPWISE_API_URL =
  process.env.SHIPWISE_API_URL ?? "https://api.shipwise.com";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Set to true if Shipwise returns rates in CENTS instead of dollars
const SHIPWISE_RETURNS_CENTS = false;

// Metafield namespace and keys for product dimensions
// You must set up these metafields in Shopify Admin > Settings > Custom data > Products
const DIMENSION_METAFIELD_NAMESPACE = "shipping"; // or "custom" - match your store setup
const DIMENSION_KEYS = {
  length: "length", // metafield key for length (in inches)
  width: "width", // metafield key for width (in inches)
  height: "height", // metafield key for height (in inches)
};

// Default dimensions if metafields are not set (fallback)
const DEFAULT_DIMENSIONS = {
  length: 10,
  width: 8,
  height: 4,
};

// Simple helper to generate a correlation ID for logging
function createCorrelationId() {
  return `shipwise-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function getOfflineShopAdminAccessToken(
  shopDomain: string | null
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

  return offlineSession?.accessToken ?? null;
}

// ---------------------------------------------------------------------------
// Helper: Exact grams -> pounds fallback conversion
// ---------------------------------------------------------------------------
function gramsToPoundsExact(grams: number) {
  if (!Number.isFinite(grams) || grams <= 0) return 0;

  // Exact conversion. Keep precision, do not round up.
  return Number((grams / 453.59237).toFixed(6));
}

// ---------------------------------------------------------------------------
// Helper: Convert Shopify's stored variant weight/unit into pounds
// ---------------------------------------------------------------------------
function shopifyWeightToPounds(
  weight: number | null | undefined,
  weightUnit: string | null | undefined
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
// Types
// ---------------------------------------------------------------------------
 main

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
  phone?: string | null;
  email?: string | null;
};

type ShopifyCartItem = {
  name?: string;
  sku?: string;
  quantity?: number;
  grams?: number;
  price?: number;
  requires_shipping?: boolean;
};

type ShopifyRateRequest = {
  rate?: {
    origin?: ShopifyAddress;
    destination?: ShopifyAddress;
    items?: ShopifyCartItem[];
    currency?: string;
  };
};

 privacy-fix-v2
function createCorrelationId() {
  return `shipwise-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

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
  // Legacy / original fields
  wasSuccessful?: boolean;
  responseMsg?: string | null;
  shipmentItems?: ShipwiseShipmentItem[] | null;
  externalServices?: ShipwiseRate[] | null;
  rateErrors?: string[] | null;

  // Newer / simplified shape used by Shipwise Akila endpoint
  success?: boolean;
  customer?: string | null;
  profileId?: string | null;
  rates?: ShipwiseRate[] | null | any[];
};

type NormalizedShipwiseRate = {
  serviceName: string;
  serviceCode: string;
  value: number;
  currency: string | null;
  estimatedDeliveryDate?: string | null;
  estimatedDeliveryDays?: number | null;
};

// ---------------------------------------------------------------------------
// Helper: Fetch variant dimensions + exact variant weight from Shopify Admin
// ---------------------------------------------------------------------------
async function fetchVariantShippingData(
  variantIds: number[],
  correlationId: string,
  requestedShopDomain: string | null,
  adminAccessToken: string | null
): Promise<Map<number, VariantShippingData>> {
  const shippingDataMap = new Map<number, VariantShippingData>();

  const adminStoreDomain = requestedShopDomain;

  // If we cannot call Shopify Admin safely for this exact shop,
  // fall back to callback grams later.
  if (!adminStoreDomain || !adminAccessToken) {
    console.warn(
      "[Shipwise] Missing per-shop Shopify Admin API credentials - exact variant weight lookup disabled; falling back to callback grams",
      {
        adminStoreDomain,
        hasAdminToken: !!adminAccessToken,
      }
    );
    return shippingDataMap;
  }

  const uniqueVariantIds = [...new Set(variantIds)];
  if (!uniqueVariantIds.length) {
    return shippingDataMap;
  }

  const variantGids = uniqueVariantIds.map(
    (id) => `gid://shopify/ProductVariant/${id}`
  );
 main

function logInfo(message: string, details: Record<string, unknown>) {
  console.log(message, details);
}

 privacy-fix-v2
function logDebug(message: string, details: Record<string, unknown>) {
  if (SHIPWISE_DEBUG_VERBOSE) console.log(message, details);
}

  try {
    const response = await fetch(
      `https://${adminStoreDomain}/admin/api/2024-10/graphql.json`,
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
      }
    );

    if (!response.ok) {
      console.error("[Shipwise] Failed to fetch variant shipping data", {
        status: response.status,
        adminStoreDomain,
      return shippingDataMap;
    }

    const data = await response.json();

    if (data.errors) {
      console.error("[Shipwise] GraphQL errors fetching variant shipping data", {
        errors: data.errors,
        adminStoreDomain,
      return shippingDataMap;
    }

    for (const node of data.data?.nodes ?? []) {
      if (!node || !node.legacyResourceId) continue;

      const variantId = parseInt(node.legacyResourceId, 10);

      const length =
        parseFloat(node.metafield_length?.value) || DEFAULT_DIMENSIONS.length;
      const width =
        parseFloat(node.metafield_width?.value) || DEFAULT_DIMENSIONS.width;
      const height =
        parseFloat(node.metafield_height?.value) || DEFAULT_DIMENSIONS.height;

      const weightLb = shopifyWeightToPounds(node.weight, node.weightUnit);

      shippingDataMap.set(variantId, {
        length,
        width,
        height,
        weightLb,
    }

    console.log("[Shipwise] Fetched variant shipping data", {
      adminStoreDomain,
      variantCount: shippingDataMap.size,
      variants: Object.fromEntries(shippingDataMap),
  } catch (err) {
    console.error("[Shipwise] Error fetching variant shipping data", {
      err,
      adminStoreDomain,
  }
 main

function gramsToPoundsExact(grams: number) {
  if (!Number.isFinite(grams) || grams <= 0) return 0;
  return Number((grams / 453.59237).toFixed(6));
}

function convertAddress(addr: ShopifyAddress | undefined, fallbackName: string) {
  return {
    name: addr?.name ?? fallbackName,
    address1: addr?.address1 ?? "",
    address2: addr?.address2 ?? "",
    city: addr?.city ?? "",
    state: addr?.province ?? addr?.province_code ?? "",
    postalCode: addr?.postal_code ?? addr?.zip ?? "",
    countryCode: addr?.country_code ?? addr?.country ?? "",
    phone: addr?.phone ?? "",
    email: addr?.email ?? "",
  };
}

type AnyRate = {
  carrierService?: string;
  carrierCode?: string;
  class?: string;
  carrier?: string;
  value?: number | string;
  currencyCodeIso?: string;
  estimatedDeliveryDate?: string;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const correlationId = createCorrelationId();
  const startedAt = Date.now();

  if (request.method !== "POST") {
 privacy-fix-v2

    console.error("[Shipwise] Non-POST request hit /api/shipwise/rates", {
      method: request.method,
 main
    return json({ error: "Method Not Allowed", correlationId }, { status: 405 });
  }

  const shopDomain =
    request.headers.get("x-shopify-shop-domain") ||
    request.headers.get("X-Shopify-Shop-Domain") ||
    null;

  const config = shopDomain
    ? await prisma.shipwiseConfig.findUnique({ where: { shop: shopDomain } })
    : null;

 privacy-fix-v2
  const shipwiseBearerToken = config?.bearerToken || process.env.SHIPWISE_BEARER_TOKEN;
  if (!shipwiseBearerToken) {
    logInfo("[Shipwise] Missing token for shop", { correlationId, shopDomain });
=======
  const shipwiseBearerToken = config?.bearerToken ?? null;

  // If no token, do not break checkout — return no rates
  if (!shipwiseBearerToken) {
    console.error("[Shipwise] No token saved for this store", {
      shopDomain,
 main
    return json({ rates: [] }, { status: 200 });
  }

  let body: ShopifyRateRequest;
  try {
 privacy-fix-v2
    body = (await request.json()) as ShopifyRateRequest;
  } catch {
    return json({ rates: [] }, { status: 400 });
  }

  const rate = body.rate;
  if (!rate) return json({ rates: [] }, { status: 400 });

  const items = (rate.items ?? []).filter((i) => i.requires_shipping !== false);

  logInfo("[Shipwise] Received rate request", {
    correlationId,
    shopDomain,
    itemCount: items.length,
    currency: rate.currency ?? "USD",
  });

  if (!items.length) return json({ rates: [] }, { status: 200 });

  const shipwiseRequestBody = {
    origin: convertAddress(rate.origin, "Origin"),
    destination: convertAddress(rate.destination, "Destination"),
    currency: rate.currency ?? "USD",
    items: items.map((item, idx) => ({
      id: idx + 1,
      sku: item.sku ?? item.name ?? `item-${idx + 1}`,

    shopifyBody = (await request.json()) as ShopifyRateRequest;
  } catch (err) {
    console.error("[Shipwise] Failed to parse Shopify JSON payload", {
      err,
    return json({ rates: [] }, { status: 400 });
  }

  const rate = shopifyBody.rate;
  if (!rate) {
    console.error("[Shipwise] Missing rate object in Shopify payload", {
      bodyKeys: Object.keys(shopifyBody || {}),
    return json({ rates: [] }, { status: 400 });
  }

  console.log("[Shipwise] Received Shopify rate request", {
    shopDomain,
    hasOrigin: !!rate.origin,
    originCountry: rate.origin?.country_code || rate.origin?.country,
    originPostal: rate.origin?.postal_code || rate.origin?.zip,
    hasDestination: !!rate.destination,
    destCountry: rate.destination?.country_code || rate.destination?.country,
    destPostal: rate.destination?.postal_code || rate.destination?.zip,
    itemCount: rate.items?.length ?? 0,
    currency: rate.currency,

  const origin = rate.origin;
  const destination = rate.destination;
  const items = rate.items ?? [];

  if (!items.length) {
    console.warn("[Shipwise] No items in Shopify rate request", {
    return json({ rates: [] }, { status: 200 });
  }

  const shopCurrency = rate.currency ?? "USD";

  // -------------------------------------------------------------------------
  // Fetch exact variant shipping data from Shopify Admin
  // -------------------------------------------------------------------------

  const shippableItems = items.filter((i) => i.requires_shipping !== false);

  const variantIds = shippableItems
    .filter((i) => i.variant_id)
    .map((i) => i.variant_id!);

  const shopifyAdminAccessToken =
    await getOfflineShopAdminAccessToken(shopDomain);

  const shippingDataMap = await fetchVariantShippingData(
    variantIds,
    shopDomain,
    shopifyAdminAccessToken
  );

  // -------------------------------------------------------------------------
  // Build Shipwise request body
  // -------------------------------------------------------------------------

  const shipwiseItems = shippableItems.map((item, index) => {
    const quantity = item.quantity ?? 1;
    const grams = item.grams ?? 0;

    const shippingData = item.variant_id
      ? shippingDataMap.get(item.variant_id)
      : undefined;

    const hasVariantWeight =
      typeof shippingData?.weightLb === "number" &&
      Number.isFinite(shippingData.weightLb) &&
      shippingData.weightLb > 0;

    const weightPerItemLb = hasVariantWeight
      ? shippingData!.weightLb!
      : gramsToPoundsExact(grams);

    if (!hasVariantWeight) {
      console.warn(
        "[Shipwise] Using callback grams fallback instead of exact Shopify variant weight",
        {
          variantId: item.variant_id,
          sku: item.sku ?? item.name ?? `item-${index + 1}`,
          grams,
          fallbackWeightLb: weightPerItemLb,
        }
      );
    }

    const length = shippingData?.length ?? DEFAULT_DIMENSIONS.length;
    const width = shippingData?.width ?? DEFAULT_DIMENSIONS.width;
    const height = shippingData?.height ?? DEFAULT_DIMENSIONS.height;

    return {
      id: index + 1,
      sku: item.sku ?? item.name ?? `item-${index + 1}`,
 main
      description: item.name ?? item.sku ?? "Item",
      quantity: item.quantity ?? 1,
      weight: gramsToPoundsExact(item.grams ?? 0),
      price: (item.price ?? 0) / 100,
 privacy-fix-v2
      length: 10,
      width: 8,
      height: 4,
    })),
  };

  logDebug("[Shipwise] Prepared request summary", {
    correlationId,
    shopDomain,
    itemCount: shipwiseRequestBody.items.length,
  });

      productId: item.product_id,
      variantId: item.variant_id,
    };

  const shipwiseOrigin = convertAddress(origin, "Origin");
  const shipwiseDestination = convertAddress(destination, "Destination");

  const shipwiseRequestBody = {
    items: shipwiseItems,
    origin: shipwiseOrigin,
    destination: shipwiseDestination,
    currency: shopCurrency,
  };

  const shipwiseUrl = `${SHIPWISE_API_URL.replace(/\/$/, "")}/api/shipping-rates`;

  console.log("[Shipwise] Sending request to Shipwise API", {
    url: shipwiseUrl,
    origin: {
      city: shipwiseOrigin.city,
      state: shipwiseOrigin.state,
      postalCode: shipwiseOrigin.postalCode,
      country: shipwiseOrigin.countryCode,
    },
    destination: {
      city: shipwiseDestination.city,
      state: shipwiseDestination.state,
      postalCode: shipwiseDestination.postalCode,
      country: shipwiseDestination.countryCode,
    },
    itemCount: shipwiseItems.length,
    items: shipwiseItems.map((i, idx) => {
      const originalItem = shippableItems[idx];
      const shippingData = originalItem?.variant_id
        ? shippingDataMap.get(originalItem.variant_id)
        : undefined;

      const hasVariantWeight =
        typeof shippingData?.weightLb === "number" &&
        Number.isFinite(shippingData.weightLb) &&
        shippingData.weightLb > 0;

      return {
        sku: i.sku,
        qty: i.quantity,
        weight: i.weight.toFixed(6),
        weightSource: hasVariantWeight
          ? "variantWeight"
          : "callbackGramsFallback",
        dims: `${i.length}x${i.width}x${i.height}`,
      };
    }),
 main

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  let shipwiseRes: Response;
  try {
    shipwiseRes = await fetch(`${SHIPWISE_API_URL.replace(/\/$/, "")}/api/shipping-rates`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${shipwiseBearerToken}`,
        "X-Correlation-ID": correlationId,
      },
      body: JSON.stringify(shipwiseRequestBody),
      signal: controller.signal,
 privacy-fix-v2
    });
  } catch {
    clearTimeout(timeoutId);

  } catch (err) {
    clearTimeout(timeoutId);
    console.error("[Shipwise] Network error calling Shipwise API", {
      err,
 main
    return json({ rates: [] }, { status: 502 });
  }
  clearTimeout(timeoutId);

  let shipwiseJson: any = {};
  try {
privacy-fix-v2
    shipwiseJson = await shipwiseRes.json();
  } catch {
    return json({ rates: [] }, { status: 502 });
  }

  const collected: Array<{ name: string; code: string; value: number; currency: string }> = [];

  const pushRate = (r: AnyRate) => {
    if (!r) return;
    const raw = typeof r.value === "string" ? Number(r.value) : r.value;
    if (!raw || Number.isNaN(raw) || raw <= 0) return;
    collected.push({
      name: r.carrierService ?? r.class ?? r.carrier ?? "Shipping",
      code: r.carrierCode ?? r.carrierService ?? r.class ?? "standard",
      value: raw,
      currency: r.currencyCodeIso ?? (rate.currency ?? "USD"),
    });
  };

  for (const item of shipwiseJson?.shipmentItems ?? []) {
    if (item?.selectedRate) pushRate(item.selectedRate as AnyRate);
    if (Array.isArray(item?.rates)) for (const r of item.rates) pushRate(r as AnyRate);

    shipwiseJson = (await shipwiseRes.json()) as ShipwiseResponse;
  } catch (err) {
    console.error("[Shipwise] Failed to parse Shipwise JSON response", {
      status: shipwiseRes.status,
      err,
    return json({ rates: [] }, { status: 502 });
  }

  console.log("[Shipwise] Received response from Shipwise", {
    status: shipwiseRes.status,
    wasSuccessful: shipwiseJson.wasSuccessful,
    success: shipwiseJson.success,
    responseMsg: shipwiseJson.responseMsg,
    shipmentItems: shipwiseJson.shipmentItems?.length ?? 0,
    externalServices: shipwiseJson.externalServices?.length ?? 0,
    rates:
      (shipwiseJson as any).rates && Array.isArray((shipwiseJson as any).rates)
        ? (shipwiseJson as any).rates.length
        : (shipwiseJson as any).rates
          ? 1
          : 0,
    rateErrors: shipwiseJson.rateErrors,


  if (
    !shipwiseRes.ok ||
    shipwiseJson.wasSuccessful === false ||
    shipwiseJson.success === false
  ) {
    console.error("[Shipwise] Shipwise API responded with error", {
      status: shipwiseRes.status,
    return json({ rates: [] }, { status: 502 });
  }

  // -------------------------------------------------------------------------
  // Normalize and collect all rates
  // -------------------------------------------------------------------------

  const allRates: NormalizedShipwiseRate[] = [];

  for (const item of shipwiseJson.shipmentItems ?? []) {
    const candidateRates: ShipwiseRate[] = [];
    if (item.selectedRate) candidateRates.push(item.selectedRate);
    if (Array.isArray(item.rates)) candidateRates.push(...item.rates);

    for (const r of candidateRates) {
      if (!r || r.value == null || r.value <= 0) continue;

      const valueInDollars = SHIPWISE_RETURNS_CENTS ? r.value / 100 : r.value;

      allRates.push({
        serviceName:
          r.carrierService ?? r.class ?? r.carrier ?? r.carrierCode ?? "Shipping",
        serviceCode: r.carrierService ?? r.carrierCode ?? r.class ?? "standard",
        value: valueInDollars,
        currency: r.currencyCodeIso ?? shopCurrency,
        estimatedDeliveryDate:
          r.estimatedDeliveryDate ?? r.transitTime?.estimatedDeliveryDate ?? null,
        estimatedDeliveryDays:
          r.estimatedDeliveryDays ?? r.transitTime?.estimatedDeliveryDays ?? null,
    }
  }

  for (const r of shipwiseJson.externalServices ?? []) {
    if (!r || r.value == null || r.value <= 0) continue;

    const valueInDollars = SHIPWISE_RETURNS_CENTS ? r.value / 100 : r.value;

    allRates.push({
      serviceName:
        r.carrierService ?? r.class ?? r.carrier ?? r.carrierCode ?? "Shipping",
      serviceCode: r.carrierService ?? r.carrierCode ?? r.class ?? "external",
      value: valueInDollars,
      currency: r.currencyCodeIso ?? shopCurrency,
      estimatedDeliveryDate:
        r.estimatedDeliveryDate ?? r.transitTime?.estimatedDeliveryDate ?? null,
      estimatedDeliveryDays:
        r.estimatedDeliveryDays ?? r.transitTime?.estimatedDeliveryDays ?? null,
  }

  const topLevelRates = (shipwiseJson as any).rates;
  if (Array.isArray(topLevelRates)) {
    console.log("[Shipwise] Processing top-level Shipwise rates", {
      count: topLevelRates.length,

    for (const raw of topLevelRates) {
      if (!raw) continue;

      const rawValue =
        (raw as any).value ??
        (raw as any).total ??
        (raw as any).amount ??
        (raw as any).price ??
        (raw as any).rate ??
        null;

      let numericValue: number | null = null;
      if (typeof rawValue === "number") {
        numericValue = rawValue;
      } else if (typeof rawValue === "string") {
        const parsed = Number(rawValue);
        if (!Number.isNaN(parsed)) {
          numericValue = parsed;
        }
      }

      if (numericValue == null || numericValue <= 0) continue;

      const valueInDollars = SHIPWISE_RETURNS_CENTS
        ? numericValue / 100
        : numericValue;

      const currency =
        (raw as any).currencyCodeIso ??
        (raw as any).currency ??
        (raw as any).currency_code ??
        shopCurrency;

      const serviceName =
        (raw as any).serviceName ??
        (raw as any).service ??
        (raw as any).carrierService ??
        (raw as any).class ??
        (raw as any).carrier ??
        (raw as any).carrierCode ??
        "Shipping";

      const serviceCode =
        (raw as any).serviceCode ??
        (raw as any).carrierService ??
        (raw as any).carrierCode ??
        (raw as any).class ??
        "standard";

      const estimatedDeliveryDays =
        (raw as any).estimatedDeliveryDays ??
        (raw as any).transitDays ??
        (raw as any).transit_time ??
        (raw as any).transitTime?.estimatedDeliveryDays ??
        null;

      const estimatedDeliveryDate =
        (raw as any).estimatedDeliveryDate ??
        (raw as any).transitTime?.estimatedDeliveryDate ??
        null;

      allRates.push({
        serviceName,
        serviceCode,
        value: valueInDollars,
        currency,
        estimatedDeliveryDate,
        estimatedDeliveryDays,
    }
 main
  }
  for (const r of shipwiseJson?.externalServices ?? []) pushRate(r as AnyRate);
  if (Array.isArray(shipwiseJson?.rates)) for (const r of shipwiseJson.rates) pushRate(r as AnyRate);

 privacy-fix-v2
  if (!collected.length) {
    logInfo("[Shipwise] No usable rates returned", {
      correlationId,
      shopDomain,
      status: shipwiseRes.status,
      latencyMs: Date.now() - startedAt,
      ratesCount: 0,
    });
    return json({ rates: [] }, { status: 200 });
  }

  const lowest = collected.reduce((a, b) => (b.value < a.value ? b : a));
  const totalPriceCents = Math.round(lowest.value * 100);

  logInfo("[Shipwise] Returning rate to Shopify", {
    correlationId,
    shopDomain,
    status: 200,
    latencyMs: Date.now() - startedAt,
    itemCount: items.length,
    ratesCount: collected.length,
  });

  if (!allRates.length) {
    console.warn("[Shipwise] No usable rates returned from Shipwise", {
    return json({ rates: [] }, { status: 200 });
  }

  console.log("[Shipwise] All rates from Shipwise", {
    rates: allRates.map((r) => ({
      service: r.serviceName,
      code: r.serviceCode,
      value: r.value,
      currency: r.currency,
    })),

  // -------------------------------------------------------------------------
  // Find the LOWEST rate
  // -------------------------------------------------------------------------

  const lowestRate = allRates.reduce((min, r) => (r.value < min.value ? r : min));

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

  console.log("[Shipwise] Returning LOWEST rate to Shopify", {
    selectedRate: {
      service: shopifyRate.service_name,
      code: shopifyRate.service_code,
      priceCents: shopifyRate.total_price,
      currency: shopifyRate.currency,
    },
    allRatesCount: allRates.length,
 main

  return json(
    {
      rates: [
        {
          service_name: lowest.name,
          service_code: lowest.code,
          total_price: totalPriceCents.toString(),
          currency: lowest.currency,
        },
      ],
    },
    { status: 200 },
  );
};
