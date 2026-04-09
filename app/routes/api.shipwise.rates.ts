import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import { apiVersion } from "../shopify.server";

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
// Helpers
// ---------------------------------------------------------------------------

function createCorrelationId() {
  return `shipwise-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function logInfo(message: string, details: Record<string, unknown>) {
  console.log(message, details);
}

function logDebug(message: string, details: Record<string, unknown>) {
  if (SHIPWISE_DEBUG_VERBOSE) console.log(message, details);
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
  });

  return offlineSession?.accessToken ?? null;
}

// ---------------------------------------------------------------------------
// Weight conversion helpers
// ---------------------------------------------------------------------------

function gramsToPoundsExact(grams: number) {
  if (!Number.isFinite(grams) || grams <= 0) return 0;
  return Number((grams / 453.59237).toFixed(6));
}

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
  variant_id?: number;
  product_id?: number;
};

type ShopifyRateRequest = {
  rate?: {
    origin?: ShopifyAddress;
    destination?: ShopifyAddress;
    items?: ShopifyCartItem[];
    currency?: string;
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
// Fetch variant shipping data from Shopify Admin
// ---------------------------------------------------------------------------

async function fetchVariantShippingData(
  variantIds: number[],
  correlationId: string,
  requestedShopDomain: string | null,
  adminAccessToken: string | null
): Promise<Map<number, VariantShippingData>> {
  const shippingDataMap = new Map<number, VariantShippingData>();

  const adminStoreDomain = requestedShopDomain;

  if (!adminStoreDomain || !adminAccessToken) {
    console.warn(
      "[Shipwise] Missing per-shop Shopify Admin API credentials - falling back to callback grams",
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

  const query = `
    query VariantShippingData($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          legacyResourceId
          weight
          weightUnit
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
      }
    );

    if (!response.ok) {
      console.error("[Shipwise] Failed to fetch variant shipping data", {
        status: response.status,
        adminStoreDomain,
      });
      return shippingDataMap;
    }

    const data = await response.json();

    if (data.errors) {
      console.error("[Shipwise] GraphQL errors fetching variant shipping data", {
        errors: data.errors,
        adminStoreDomain,
      });
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

      shippingDataMap.set(variantId, { length, width, height, weightLb });
    }

    console.log("[Shipwise] Fetched variant shipping data", {
      adminStoreDomain,
      variantCount: shippingDataMap.size,
    });
  } catch (err) {
    console.error("[Shipwise] Error fetching variant shipping data", {
      err,
      adminStoreDomain,
    });
  }

  return shippingDataMap;
}

// ---------------------------------------------------------------------------
// Address conversion
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Action handler
// ---------------------------------------------------------------------------

export const action = async ({ request }: ActionFunctionArgs) => {
  const correlationId = createCorrelationId();
  const startedAt = Date.now();

  if (request.method !== "POST") {
    console.error("[Shipwise] Non-POST request hit /api/shipwise/rates", {
      method: request.method,
    });
    return json({ error: "Method Not Allowed", correlationId }, { status: 405 });
  }

  const shopDomain =
    request.headers.get("x-shopify-shop-domain") ||
    request.headers.get("X-Shopify-Shop-Domain") ||
    null;

  const config = shopDomain
    ? await prisma.shipwiseConfig.findUnique({ where: { shop: shopDomain } })
    : null;

  const shipwiseBearerToken = config?.bearerToken ?? null;

  if (!shipwiseBearerToken) {
    console.error("[Shipwise] No token saved for this store", {
      shopDomain,
      correlationId,
    });
    return json({ rates: [] }, { status: 200 });
  }

  let shopifyBody: ShopifyRateRequest;
  try {
    shopifyBody = (await request.json()) as ShopifyRateRequest;
  } catch (err) {
    console.error("[Shipwise] Failed to parse Shopify JSON payload", {
      err,
      correlationId,
    });
    return json({ rates: [] }, { status: 400 });
  }

  const rate = shopifyBody.rate;
  if (!rate) {
    console.error("[Shipwise] Missing rate object in Shopify payload", {
      bodyKeys: Object.keys(shopifyBody || {}),
      correlationId,
    });
    return json({ rates: [] }, { status: 400 });
  }

  const origin = rate.origin;
  const destination = rate.destination;
  const items = rate.items ?? [];

  logInfo("[Shipwise] Received Shopify rate request", {
    correlationId,
    shopDomain,
    hasOrigin: !!origin,
    originCountry: origin?.country_code || origin?.country,
    hasDestination: !!destination,
    destCountry: destination?.country_code || destination?.country,
    itemCount: items.length,
    currency: rate.currency,
  });

  if (!items.length) {
    console.warn("[Shipwise] No items in Shopify rate request", { correlationId });
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
    correlationId,
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
          correlationId,
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
      description: item.name ?? item.sku ?? "Item",
      quantity,
      weight: weightPerItemLb,
      price: (item.price ?? 0) / 100,
      length,
      width,
      height,
      productId: item.product_id,
      variantId: item.variant_id,
    };
  });

  const shipwiseOrigin = convertAddress(origin, "Origin");
  const shipwiseDestination = convertAddress(destination, "Destination");

  const shipwiseRequestBody = {
    items: shipwiseItems,
    origin: shipwiseOrigin,
    destination: shipwiseDestination,
    currency: shopCurrency,
  };

  const shipwiseUrl = `${SHIPWISE_API_URL.replace(/\/$/, "")}/api/shipping-rates`;

  logDebug("[Shipwise] Prepared request summary", {
    correlationId,
    shopDomain,
    url: shipwiseUrl,
    itemCount: shipwiseItems.length,
  });

  // -------------------------------------------------------------------------
  // Call Shipwise API
  // -------------------------------------------------------------------------

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
  } catch (err) {
    clearTimeout(timeoutId);
    console.error("[Shipwise] Network error calling Shipwise API", {
      err,
      correlationId,
    });
    return json({ rates: [] }, { status: 502 });
  }
  clearTimeout(timeoutId);

  let shipwiseJson: ShipwiseResponse = {};
  try {
    shipwiseJson = (await shipwiseRes.json()) as ShipwiseResponse;
  } catch (err) {
    console.error("[Shipwise] Failed to parse Shipwise JSON response", {
      status: shipwiseRes.status,
      err,
      correlationId,
    });
    return json({ rates: [] }, { status: 502 });
  }

  logInfo("[Shipwise] Received response from Shipwise", {
    correlationId,
    status: shipwiseRes.status,
    wasSuccessful: shipwiseJson.wasSuccessful,
    success: shipwiseJson.success,
    responseMsg: shipwiseJson.responseMsg,
    shipmentItems: shipwiseJson.shipmentItems?.length ?? 0,
    externalServices: shipwiseJson.externalServices?.length ?? 0,
    topLevelRates: Array.isArray(shipwiseJson.rates) ? shipwiseJson.rates.length : 0,
    rateErrors: shipwiseJson.rateErrors,
  });

  if (
    !shipwiseRes.ok ||
    shipwiseJson.wasSuccessful === false ||
    shipwiseJson.success === false
  ) {
    console.error("[Shipwise] Shipwise API responded with error", {
      status: shipwiseRes.status,
      correlationId,
    });
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
      });
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
    });
  }

  // Handle top-level rates (newer Shipwise response shape)
  const topLevelRates = shipwiseJson.rates;
  if (Array.isArray(topLevelRates)) {
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
      });
    }
  }

  if (!allRates.length) {
    logInfo("[Shipwise] No usable rates returned", {
      correlationId,
      shopDomain,
      status: shipwiseRes.status,
      latencyMs: Date.now() - startedAt,
    });
    return json({ rates: [] }, { status: 200 });
  }

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

  logInfo("[Shipwise] Returning LOWEST rate to Shopify", {
    correlationId,
    shopDomain,
    selectedRate: {
      service: shopifyRate.service_name,
      code: shopifyRate.service_code,
      priceCents: shopifyRate.total_price,
      currency: shopifyRate.currency,
    },
    allRatesCount: allRates.length,
    latencyMs: Date.now() - startedAt,
  });

  return json(
    {
      rates: [shopifyRate],
    },
    { status: 200 }
  );
};
